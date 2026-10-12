import { readBoundedResponseBytes } from "@rakazo/core";
import { rpc, selectedSpaceId, withSpaceHeaders } from "./rpc.js";

export type SpeechStatus = "idle" | "preparing" | "speaking";

export interface SpeechSnapshot {
  status: SpeechStatus;
  botId?: string;
  messageId?: string;
  caption?: string;
  error?: string;
}

interface SpeakOptions {
  voiceId?: string;
  botId?: string;
  messageId?: string;
}

type TtsErrorBody = { error?: string };

const IDLE: SpeechSnapshot = { status: "idle" };
export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_ERROR_BYTES = 64 * 1024;

export class Speaker {
  private snapshot: SpeechSnapshot = IDLE;
  private watchers = new Set<(s: SpeechSnapshot) => void>();
  private token = 0;
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private settlePlayback: ((finished: boolean) => void) | null = null;
  private request: AbortController | null = null;
  /** The call panel taps each clip it plays, to draw the voice wave. */
  audioTap: ((audio: HTMLAudioElement) => void) | null = null;
  /** Where streamed speech plays; the call panel routes it through its wave analyser. */
  output: { context: AudioContext; destination: AudioNode } | null = null;
  /** null until the first try; false when the voice provider cannot stream. */
  private streaming: boolean | null = null;
  private ownContext: AudioContext | null = null;

  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): SpeechSnapshot {
    return this.snapshot;
  }

  private set(next: SpeechSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  isSpeaking(messageId?: string): boolean {
    if (this.snapshot.status === "idle") return false;
    return messageId ? this.snapshot.messageId === messageId : true;
  }

  stop() {
    this.token += 1;
    this.request?.abort();
    this.request = null;
    if (this.settlePlayback) this.settlePlayback(false);
    else this.teardownAudio();
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  private teardownAudio() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const mine = this.token;
    const controller = new AbortController();
    this.request = controller;
    const live = () => this.token === mine && !controller.signal.aborted;
    const spaceId = selectedSpaceId();

    this.set({ status: "preparing", botId: opts.botId, messageId: opts.messageId });
    let utterances: string[];
    try {
      utterances = await withAbort(controller.signal, () =>
        this.prepare(text, opts, controller.signal, spaceId),
      );
    } catch (error) {
      if (live()) {
        this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error) });
      }
      if (this.request === controller) this.request = null;
      return;
    }
    if (!live()) return;
    if (!utterances.length) {
      this.set(IDLE);
      if (this.request === controller) this.request = null;
      return;
    }

    if (this.streaming !== false) {
      try {
        const streamed = await this.speakStreamed(
          utterances,
          opts,
          controller.signal,
          spaceId,
          live,
        );
        if (streamed !== null) {
          if (live()) this.set(IDLE);
          if (this.request === controller) this.request = null;
          return;
        }
      } catch (error) {
        if (live()) {
          this.set({ ...IDLE, error: error instanceof Error ? error.message : String(error) });
        }
        if (this.request === controller) this.request = null;
        return;
      }
    }

    type Rendered = { blob: Blob; error?: never } | { blob?: never; error: unknown };
    const render = (utterance: string): Promise<Rendered> =>
      this.render(utterance, opts, controller.signal, spaceId).then(
        (blob) => ({ blob }),
        (error: unknown) => ({ error }),
      );
    let next: Promise<Rendered> | null = render(utterances[0] ?? "");
    for (let i = 0; i < utterances.length; i += 1) {
      const current = next;
      next = i + 1 < utterances.length ? render(utterances[i + 1] ?? "") : null;
      if (!current) break;
      const rendered = await current;
      if ("error" in rendered) {
        if (live()) {
          this.set({
            ...IDLE,
            error:
              rendered.error instanceof Error ? rendered.error.message : String(rendered.error),
          });
        }
        if (this.request === controller) this.request = null;
        return;
      }
      if (!live()) return;
      this.set({
        status: "speaking",
        botId: opts.botId,
        messageId: opts.messageId,
        caption: utterances[i],
      });
      const finished = await this.play(rendered.blob, live);
      if (!finished || !live()) {
        if (live()) this.set(IDLE);
        if (this.request === controller) this.request = null;
        return;
      }
    }
    if (live()) this.set(IDLE);
    if (this.request === controller) this.request = null;
  }

  /**
   * Plays each sentence as its audio streams in (16-bit mono PCM), back to back with no gaps,
   * so the first words are heard well before the clip is finished. Returns null when the voice
   * provider does not stream, so the caller falls back to whole clips.
   */
  private async speakStreamed(
    utterances: string[],
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
    live: () => boolean,
  ): Promise<boolean | null> {
    if (!this.output && !this.ownContext) this.ownContext = new AudioContext();
    const out = this.output ?? {
      context: this.ownContext as AudioContext,
      destination: (this.ownContext as AudioContext).destination,
    };
    const ac = out.context;
    void ac.resume().catch(() => {});
    const sources: AudioBufferSourceNode[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let next = 0;
    let settled = false;
    let resolveFinished: (ok: boolean) => void = () => {};
    const finished = new Promise<boolean>((resolve) => {
      resolveFinished = resolve;
    });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already ended
        }
      }
      for (const timer of timers) clearTimeout(timer);
      if (this.settlePlayback === done) this.settlePlayback = null;
      resolveFinished(ok);
    };
    this.settlePlayback = done;

    for (let i = 0; i < utterances.length; i += 1) {
      const res = await fetch("/api/voice/speak-stream", {
        method: "POST",
        headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
        credentials: "include",
        body: JSON.stringify({ text: utterances[i], voiceId: opts.voiceId, botId: opts.botId }),
        signal,
      });
      if (i === 0 && res.status === 404) {
        this.streaming = false;
        done(false);
        return null;
      }
      if (!res.ok || !res.body) {
        const body = await readVoiceError(res, signal);
        done(false);
        throw new Error(body.error ?? `the voice service returned ${res.status}`);
      }
      this.streaming = true;
      const rate = Number(res.headers.get("x-sample-rate")) || 24000;
      const reader = res.body.getReader();
      let carry: Uint8Array | null = null;
      let first = true;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (!live() || settled) {
          void reader.cancel().catch(() => {});
          done(false);
          return false;
        }
        let bytes = value;
        if (carry) {
          const merged = new Uint8Array(carry.length + value.length);
          merged.set(carry);
          merged.set(value, carry.length);
          bytes = merged;
        }
        const samples = bytes.length >> 1;
        carry = bytes.length & 1 ? bytes.slice(samples * 2) : null;
        if (!samples) continue;
        const pcm = new Int16Array(bytes.slice(0, samples * 2).buffer);
        const floats = new Float32Array(samples);
        for (let k = 0; k < samples; k += 1) floats[k] = (pcm[k] ?? 0) / 32768;
        const buffer = ac.createBuffer(1, samples, rate);
        buffer.copyToChannel(floats, 0);
        const source = ac.createBufferSource();
        source.buffer = buffer;
        source.connect(out.destination);
        // A short lead before the first chunk, then each chunk right after the previous one.
        const at = Math.max(next, ac.currentTime + (next ? 0.02 : 0.15));
        source.start(at);
        next = at + buffer.duration;
        sources.push(source);
        if (first) {
          first = false;
          const caption = utterances[i];
          timers.push(
            setTimeout(
              () => {
                if (live() && !settled) {
                  this.set({
                    status: "speaking",
                    botId: opts.botId,
                    messageId: opts.messageId,
                    caption,
                  });
                }
              },
              Math.max(0, (at - ac.currentTime) * 1000),
            ),
          );
        }
      }
    }
    timers.push(setTimeout(() => done(true), Math.max(0, (next - ac.currentTime) * 1000) + 50));
    return finished;
  }

  private async prepare(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<string[]> {
    const body = await rpc.voice.prepare(
      { text, voiceId: opts.voiceId, botId: opts.botId },
      { signal, context: { spaceId } },
    );
    if (!body.ready) {
      throw new Error("Add a voice provider key and pick a voice in Voice settings.");
    }
    return body.utterances ?? [];
  }

  private async render(
    text: string,
    opts: SpeakOptions,
    signal: AbortSignal,
    spaceId: string | null,
  ): Promise<Blob> {
    const deadline = requestDeadline(signal, VOICE_RESPONSE_TIMEOUT_MS);
    try {
      const res = await withAbort(deadline.signal, () =>
        fetch("/api/voice/speak", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({ text, voiceId: opts.voiceId, botId: opts.botId }),
          signal: deadline.signal,
        }),
      );
      if (!res.ok) {
        const body = await readVoiceError(res, deadline.signal);
        throw new Error(body.error ?? `the voice service returned ${res.status}`);
      }
      const bytes = await readResponseBytes(res, MAX_VOICE_AUDIO_BYTES, deadline.signal);
      return new Blob([new Uint8Array(bytes)], {
        type: res.headers.get("content-type") ?? "audio/mpeg",
      });
    } finally {
      deadline.dispose();
    }
  }

  private play(blob: Blob, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!live()) return resolve(false);
      this.teardownAudio();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      this.audioTap?.(audio);
      this.objectUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        if (this.settlePlayback === done) this.settlePlayback = null;
        if (this.audio === audio) this.teardownAudio();
        resolve(ok);
      };
      this.settlePlayback = done;
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.play().catch(() => done(false));
    });
  }
}

export const speaker = new Speaker();

function withAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    run().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function requestDeadline(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Voice request timed out.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

async function readVoiceError(response: Response, signal: AbortSignal): Promise<TtsErrorBody> {
  const bytes = await readResponseBytes(response, MAX_VOICE_ERROR_BYTES, signal);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TtsErrorBody) : {};
  } catch {
    return {};
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponse(response);
    throw new Error("Voice response is too large.");
  }
  return readBoundedResponseBytes(response, {
    maxBytes,
    tooLargeMessage: "Voice response is too large.",
    read: (operation) => withAbort(signal, operation),
  });
}

function cancelResponse(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}
