import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage, ThreadSnapshot, VoiceInfo } from "@rakazo/contracts";
import { isSecretAskBlock, narrateTool, speechFromBlocks, spokenDecision } from "@rakazo/core";
import { Mic, MicOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dictation } from "../lib/dictation";
import { BACKCHANNEL, Ears, type EarsEvent } from "../lib/ears";
import { rpc } from "../lib/rpc";
import { speaker } from "../lib/tts";

type Phase = "listening" | "thinking" | "speaking";

// The RTL Command Center's voice panel wave (asstWaveLoop): the colour is the state.
const WAVE_BARS = 36;
const WAVE_LISTENING = "#34d399";
const WAVE_REPLYING = "#818cf8";
const WAVE_MUTED = "#f87171";

/**
 * Voice call as a side panel beside the conversation, the same panel as the RTL Command
 * Center and Classroom: a wave whose colour is the state, the words heard or spoken, a voice
 * picker, mute and close. With the self-hosted ears, talking over a reply interrupts it.
 */
export function CallView({
  botId,
  botName,
  voiceId,
  onVoiceSaved,
  transcribe,
  snapshot,
  onSend,
  onFollowUp,
  onAnswer,
  onClose,
}: {
  botId: string;
  botName: string;
  voiceId: string;
  onVoiceSaved: () => void;
  transcribe: boolean;
  snapshot: ThreadSnapshot | null;
  onSend: (text: string) => Promise<void>;
  onFollowUp: (text: string) => Promise<void>;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [phase, setPhase] = useState<Phase>("listening");
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<Phase>("listening");
  const spokenMessage = useRef<string | null>(null);
  const narrated = useRef(new Set<string>());
  const closing = useRef(false);
  // With the self-hosted ears the mic stays open for the whole call, so talking interrupts a reply.
  const ears = useRef(new Ears());
  const [earsOn, setEarsOn] = useState(false);
  const earsOnRef = useRef(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [ignored, setIgnored] = useState(false);
  const ignoredTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voice, setVoice] = useState(voiceId);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const outAnalyser = useRef<AnalyserNode | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const askPromptRef = useRef(t`Say yes or no, or answer in a sentence.`);
  askPromptRef.current = t`Say yes or no, or answer in a sentence.`;
  const secretPromptRef = useRef(t`Hang up first, then enter the code on screen.`);
  secretPromptRef.current = t`Hang up first, then enter the code on screen.`;

  function setCallPhase(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function hangUp() {
    closing.current = true;
    ears.current.stop();
    dictation.stop("cancel");
    speaker.stop();
    onClose();
  }

  function interrupt() {
    if (phaseRef.current === "speaking") speaker.stop();
    else if (!earsOnRef.current) dictation.stop("cancel");
    void listen();
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    ears.current.muted = next;
    if (next) {
      ears.current.reset();
      dictation.stop("cancel");
      setHeard("");
    } else if (phaseRef.current === "listening") {
      void listen();
    }
  }

  async function pickVoice(next: string) {
    setVoice(next);
    try {
      await rpc.bots.update({ botId, voiceId: next || null });
      onVoiceSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that voice`);
    }
  }

  async function listen() {
    if (closing.current) return;
    if (pendingSecretAsk(snapshotRef.current)) {
      dictation.stop("cancel");
      setCallPhase("listening");
      setHeard("");
      return;
    }
    if (mutedRef.current) {
      // Muted stays muted until the user unmutes; nothing is heard meanwhile.
      setCallPhase("listening");
      return;
    }
    if (earsOnRef.current) {
      // The ears are always listening; while a run is still working, show that instead.
      const run = snapshotRef.current?.run;
      setCallPhase(
        run && ["running", "queued", "leased"].includes(run.status) ? "thinking" : "listening",
      );
      setHeard("");
      return;
    }
    setCallPhase("listening");
    speaker.stop();
    setHeard("");
    try {
      await dictation.listen({
        mode: "endpoint",
        transcribe,
        onFinal: (text) => void handleTranscript(text),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Microphone failed`);
    }
  }

  async function handleTranscript(text: string) {
    if (closing.current || !text.trim()) {
      void listen();
      return;
    }
    if (!earsOnRef.current) dictation.stop("submit");
    const current = snapshotRef.current;
    if (pendingSecretAsk(current)) {
      setHeard("");
      setCaption("");
      setError(t`Hang up, then enter the code on screen.`);
      return;
    }
    setHeard(text);
    setCallPhase("thinking");
    const askId = latestAskId(current);
    const askMessage = current?.messages.find((message) => message.id === askId);
    try {
      if (askMessage) {
        const decision = spokenDecision(text);
        await onAnswer(askMessage, decision ?? text);
      } else if (current?.run && ["running", "queued", "leased"].includes(current.run.status)) {
        await onFollowUp(text);
      } else {
        await onSend(text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not send that`);
      void listen();
    }
  }

  function onEars(event: EarsEvent) {
    if (closing.current) return;
    const speaking = phaseRef.current === "speaking";
    if (event.type === "partial") {
      if (!speaking) setHeard(event.text);
      // A real sentence (2+ words, not "mm-hm") cuts the reply off; the final then asks.
      else if (event.text.split(/\s+/).length >= 2 && !BACKCHANNEL.test(event.text)) speaker.stop();
    } else if (event.type === "dropped") {
      setIgnored(true);
      clearTimeout(ignoredTimer.current);
      ignoredTimer.current = setTimeout(() => setIgnored(false), 2500);
    } else if (event.type === "final" && event.text) {
      if (event.stop) {
        speaker.stop();
        setHeard("");
        return;
      }
      if (speaking && BACKCHANNEL.test(event.text)) return;
      speaker.stop();
      void handleTranscript(event.text);
    }
  }

  useEffect(() => {
    closing.current = false;
    spokenMessage.current = null;
    narrated.current.clear();
    const unsubSpeech = speaker.subscribe((state) => {
      if (state.status === "speaking") {
        setCallPhase("speaking");
        setCaption(state.caption ?? "");
      } else if (state.status === "idle" && phaseRef.current !== "listening") {
        setCaption("");
        void listen();
      }
      if (state.error) setError(state.error);
    });
    const unsubDictation = dictation.subscribe((state) => {
      if (state.status === "listening") {
        setHeard(pendingSecretAsk(snapshotRef.current) ? "" : state.transcript);
      }
      if (state.error) setError(state.error);
    });
    void (async () => {
      const ok = await ears.current.start(onEars, () => {
        earsOnRef.current = false;
        setEarsOn(false);
        if (!closing.current) void listen();
      });
      if (closing.current) {
        ears.current.stop();
        return;
      }
      earsOnRef.current = ok;
      setEarsOn(ok);
      void listen();
    })();
    return () => {
      closing.current = true;
      ears.current.stop();
      unsubSpeech();
      unsubDictation();
      dictation.stop("cancel");
      speaker.stop();
    };
  }, [botId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        hangUp();
      }
      if (event.key === " " && phaseRef.current !== "listening") {
        event.preventDefault();
        interrupt();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (closing.current || phaseRef.current === "listening") return;
    const messages = snapshot?.messages ?? [];
    const lastBot = [...messages].reverse().find((message) => message.role === "bot");
    if (lastBot && lastBot.id !== spokenMessage.current) {
      const text = speechFromBlocks(lastBot.blocks);
      const ask = lastBot.blocks.find(
        (block) => block.kind === "ask" && block.status !== "answered",
      );
      const secretAsk = ask && isSecretAskBlock(ask);
      if (text) {
        spokenMessage.current = lastBot.id;
        dictation.stop("cancel");
        void speaker.speak(
          secretAsk
            ? `${text}. ${secretPromptRef.current}`
            : ask
              ? `${text}. ${askPromptRef.current}`
              : text,
          {
            botId,
            messageId: lastBot.id,
          },
        );
        return;
      }
      const runActive =
        snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status);
      if (!runActive) {
        spokenMessage.current = lastBot.id;
        void listen();
        return;
      }
    }
    if (snapshot?.run && ["running", "queued", "leased"].includes(snapshot.run.status)) {
      const phrases: string[] = [];
      let lastKey = "";
      for (const message of messages) {
        for (const block of message.blocks) {
          if (block.kind !== "progress" && block.kind !== "subagent") continue;
          const key = `${message.id}:${block.kind}:${block.kind === "subagent" ? block.status : block.text}`;
          if (narrated.current.has(key)) continue;
          const phrase =
            block.kind === "subagent"
              ? narrateTool("run_subagent")
              : (narrateTool(block.text.split(/\s+/)[0] ?? "") ?? speakableProgress(block.text));
          if (!phrase) continue;
          narrated.current.add(key);
          phrases.push(phrase);
          lastKey = key;
        }
      }
      if (phrases.length) {
        void speaker.speak(phrases.join(". "), { botId, messageId: `narrate:${lastKey}` });
      }
    }
  }, [snapshot, botId]);

  useEffect(() => {
    if (!pendingSecretAsk(snapshot)) return;
    dictation.stop("cancel");
    setHeard("");
  }, [snapshot]);

  // The bot's voice, tapped for the wave while it speaks.
  useEffect(() => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(context.destination);
    outAnalyser.current = analyser;
    speaker.output = { context, destination: analyser };
    speaker.audioTap = (audio) => {
      void context.resume().catch(() => {});
      context.createMediaElementSource(audio).connect(analyser);
    };
    return () => {
      speaker.output = null;
      speaker.audioTap = null;
      outAnalyser.current = null;
      void context.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
  }, []);

  // The wave: green follows your voice while it listens, indigo follows the reply, red is muted.
  useEffect(() => {
    const bars = new Float32Array(WAVE_BARS);
    const buffer = new Float32Array(1024);
    let micFloor = 0.01;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const c = canvas.current;
      const g = c?.getContext("2d");
      if (!c || !g) return;
      const speaking = phaseRef.current === "speaking";
      const analyser = mutedRef.current
        ? null
        : speaking
          ? outAnalyser.current
          : ears.current.analyser;
      let gain = 0;
      let floor = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(buffer);
        gain = speaking ? 4.5 : 7;
        if (!speaking) {
          let energy = 0;
          for (const x of buffer) energy += x * x;
          const rms = Math.sqrt(energy / buffer.length);
          micFloor = rms < micFloor ? rms : micFloor * 1.002; // the room's own hum, tracked slowly
          floor = Math.max(micFloor * 2, 0.006);
        }
      }
      const per = Math.floor(buffer.length / WAVE_BARS);
      for (let i = 0; i < WAVE_BARS; i++) {
        let energy = 0;
        if (analyser) for (let k = i * per; k < (i + 1) * per; k++) energy += (buffer[k] ?? 0) ** 2;
        const level = analyser
          ? Math.min(1, Math.max(0, Math.sqrt(energy / per) - floor) * gain)
          : 0;
        const bar = bars[i] ?? 0;
        bars[i] = level > bar ? bar * 0.35 + level * 0.65 : bar * 0.8 + level * 0.2; // fast up, slower down
      }
      const width = c.width;
      const height = c.height;
      g.clearRect(0, 0, width, height);
      const radius = width * 0.46;
      const gap = (2 * radius) / WAVE_BARS;
      const barWidth = gap * 0.55;
      g.fillStyle = mutedRef.current
        ? WAVE_MUTED
        : phaseRef.current === "listening"
          ? WAVE_LISTENING
          : WAVE_REPLYING;
      for (let i = 0; i < WAVE_BARS; i++) {
        const x = width / 2 - radius + gap * i + (gap - barWidth) / 2;
        const t = (i + 0.5) / WAVE_BARS;
        const envelope = 0.35 + 0.65 * Math.sqrt(1 - (2 * t - 1) ** 2);
        const h = Math.max(barWidth, (bars[i] ?? 0) * height * 0.9 * envelope);
        g.beginPath();
        g.roundRect(x, height / 2 - h / 2, barWidth, h, barWidth / 2);
        g.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  const state = muted
    ? t`Muted`
    : phase === "listening"
      ? t`Listening…`
      : phase === "speaking"
        ? t`Speaking`
        : t`Thinking…`;
  const words = phase === "speaking" ? caption : heard;

  return (
    <aside
      data-testid="call-view"
      aria-label={t`Call with ${botName}`}
      className="absolute inset-y-0 end-0 z-30 flex w-full flex-col items-center border-s border-sidebar-border bg-background px-5 pt-4 pb-5 md:relative md:w-[400px] md:shrink-0"
    >
      <div className="flex w-full items-center justify-between gap-3">
        <span className="truncate text-[13.5px] text-muted-foreground">{botName}</span>
        <select
          aria-label={t`Voice`}
          value={voice}
          onChange={(event) => void pickVoice(event.target.value)}
          className="h-8 max-w-[60%] rounded-md border border-border bg-background px-2 text-[13px] text-foreground"
        >
          {voice ? null : <option value="">{t`Choose a voice`}</option>}
          {voices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-3">
        <button
          type="button"
          onClick={interrupt}
          title={t`Tap to interrupt`}
          aria-label={t`Tap to interrupt`}
          className="h-32 w-[220px] cursor-pointer rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <canvas ref={canvas} width={440} height={256} className="block h-full w-full" />
        </button>
        <div className="text-[17px] font-semibold text-foreground">{state}</div>
        <p className="min-h-[3em] max-w-full px-1.5 text-center text-[14.5px] leading-[1.55] text-muted-foreground">
          {words}
        </p>
        <p className="min-h-[1.2em] text-[12px] text-muted-foreground/80">
          {ignored ? t`(background, ignored)` : ""}
        </p>
        {error ? <p className="text-center text-[13px] text-destructive">{error}</p> : null}
      </div>
      <p className="mb-3 text-center text-[12px] text-muted-foreground">
        {earsOn ? (
          <Trans>Just talk, or tap the wave, to interrupt</Trans>
        ) : (
          <Trans>Tap the wave or press Space to interrupt</Trans>
        )}
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={toggleMute}
          title={muted ? t`Unmute` : t`Mute`}
          aria-label={muted ? t`Unmute` : t`Mute`}
          aria-pressed={muted}
          className={`flex size-11 items-center justify-center rounded-full border ${
            muted
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border text-foreground hover:bg-accent"
          }`}
        >
          {muted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={hangUp}
          title={t`End call`}
          aria-label={t`End call`}
          className="flex size-11 items-center justify-center rounded-full border border-border text-foreground hover:bg-accent"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

function pendingSecretAsk(snapshot: ThreadSnapshot | null) {
  const askId = latestAskId(snapshot);
  const askMessage = snapshot?.messages.find((message) => message.id === askId);
  return askMessage?.blocks.some(
    (block) => block.kind === "ask" && isSecretAskBlock(block) && block.status !== "answered",
  );
}

function latestAskId(snapshot: ThreadSnapshot | null): string | null {
  if (snapshot?.run?.status !== "waiting_input") return null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.runId !== snapshot.run.id) continue;
    if (message.blocks.some((block) => block.kind === "ask" && block.status !== "answered")) {
      return message.id;
    }
  }
  return null;
}

function speakableProgress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return null;
  return trimmed;
}
