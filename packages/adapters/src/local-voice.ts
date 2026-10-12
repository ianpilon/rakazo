import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { readVoiceAudio, readVoiceJson, requireOk, voiceDeadline } from "./voice-http.js";

/**
 * Self-hosted OpenAI-compatible speech server (for example a Voice Lab shim in
 * front of a local TTS model). Like the local model server, it is configured by
 * the operator through the environment and needs no key: the credential the
 * settings screen stores is a placeholder.
 */
export const LOCAL_VOICE_URL_ENV = "RAKAZO_LOCAL_VOICE_URL";

export function localVoiceBaseUrl(): string | null {
  const value = process.env[LOCAL_VOICE_URL_ENV]?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${LOCAL_VOICE_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${LOCAL_VOICE_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  return value.replace(/\/+$/, "");
}

function baseUrl(): string {
  const url = localVoiceBaseUrl();
  if (!url) throw new Error(`Set ${LOCAL_VOICE_URL_ENV} to use your own voice server.`);
  return url;
}

export class LocalVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "local",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(_apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${baseUrl()}/audio/voices`, {
        signal: voiceDeadline(context.signal, 10_000),
      });
      if (res.ok) return { ok: true };
      return { ok: false, message: `Your voice server answered ${res.status}.` };
    } catch {
      return { ok: false, message: "Couldn't reach your voice server." };
    }
  }

  async listVoices(_apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${baseUrl()}/audio/voices`, {
      signal: voiceDeadline(context.signal, 10_000),
    });
    await requireOk(res, "Your voice server", "listing voices");
    const body = (await readVoiceJson(res)) as {
      voices?: Array<{ id?: unknown; name?: unknown }>;
    } | null;
    return (body?.voices ?? [])
      .filter((voice) => typeof voice.id === "string" && voice.id)
      .map((voice) => ({ id: String(voice.id), label: String(voice.name ?? voice.id) }));
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${baseUrl()}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: request.voiceId, input: request.text }),
      signal,
    });
    await requireOk(res, "Your voice server", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/wav" };
  }

  async synthesizeStream(
    request: VoiceSynthesizeRequest,
    context: AdapterContext,
  ): Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number }> {
    const res = await fetch(`${baseUrl()}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: request.voiceId, input: request.text, stream: true }),
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    await requireOk(res, "Your voice server", "speaking");
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("octet-stream")) {
      throw new Error("Your voice server did not stream audio.");
    }
    return { stream: res.body, sampleRate: Number(res.headers.get("x-sample-rate")) || 24000 };
  }
}
