/**
 * Self-hosted listening for calls: the mic streams 16 kHz PCM to an ears service at /ears on
 * this host, where voice activity detection finds real speech and a local model writes the
 * words (partials while you talk, a final when you stop). The ears also flag stop phrases
 * ("stop", "wait"). Because the mic stays open while a reply is spoken, talking over the bot
 * can interrupt it. When /ears is not deployed, start() resolves false and calls fall back to
 * dictation.
 */
export type EarsEvent =
  | { type: "start" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; stop: boolean }
  | { type: "dropped" }
  | { type: "end" };

/** Short acknowledgements that should not cut a spoken reply off. */
export const BACKCHANNEL = /^(mm+|mhm|uh[- ]?huh|uh|um|hmm+|ok(ay)?|yeah|yes|right|sure)[.!]?$/i;

export class Ears {
  private ws: WebSocket | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  /** The mic level, for the call panel's wave. */
  analyser: AnalyserNode | null = null;
  muted = false;

  get active() {
    return this.ws !== null;
  }

  async start(onEvent: (event: EarsEvent) => void, onLost: () => void): Promise<boolean> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // No auto gain: a voice across the room stays quiet, so the ears can tell it is far away.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
    } catch {
      return false;
    }
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(`${proto}${location.host}/ears`);
    ws.binaryType = "arraybuffer";
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      ws.onmessage = (event) => {
        try {
          if (JSON.parse(String(event.data)).type === "ready") {
            clearTimeout(timer);
            resolve(true);
          }
        } catch {
          // ignore anything before ready
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
    if (!ready) {
      ws.close();
      for (const track of stream.getTracks()) track.stop();
      return false;
    }

    this.ws = ws;
    this.stream = stream;
    const context = new AudioContext();
    this.context = context;
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    this.node = node;
    const sink = context.createGain();
    sink.gain.value = 0;
    const ratio = context.sampleRate / 16000;
    node.onaudioprocess = (event) => {
      if (this.muted || ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const length = Math.floor(input.length / ratio);
      const out = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        const position = i * ratio;
        const j = Math.floor(position);
        const a = input[j] ?? 0;
        const b = input[j + 1] ?? a;
        const value = a + (b - a) * (position - j);
        out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      }
      ws.send(out.buffer);
    };
    source.connect(node);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    this.analyser = analyser;
    node.connect(sink);
    sink.connect(context.destination);

    ws.onmessage = (event) => {
      let message: { type?: string; text?: unknown; stop?: unknown } = {};
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (this.muted) return;
      const text = String(message.text ?? "").trim();
      if (message.type === "start") onEvent({ type: "start" });
      else if (message.type === "partial") onEvent({ type: "partial", text });
      else if (message.type === "final")
        onEvent({ type: "final", text, stop: Boolean(message.stop) });
      else if (message.type === "dropped") onEvent({ type: "dropped" });
      else if (message.type === "end") onEvent({ type: "end" });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stop();
      onLost();
    };
    return true;
  }

  /** Forget anything heard so far (for example after a reply was interrupted). */
  reset() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "reset" }));
  }

  stop() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.node?.disconnect();
    this.node = null;
    this.analyser = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}
