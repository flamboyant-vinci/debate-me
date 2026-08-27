// Everything behind #soundcheck: prove the voices, the microphone path and the
// APIs work before you commit to a ninety-minute round. Runs without an active
// round, so it is handled at the socket layer rather than by the engine.
import type { VoiceProfile } from "../src/shared/types.ts";
import { DEBATERS, JUDGES } from "../src/shared/roster.ts";
import { providerStatus, probeProviders, transcribe } from "./ai/llm.ts";
import { speakText, usage } from "./tts/rumik.ts";
import type { SpokenChunk } from "./tts/rumik.ts";

export interface VoiceOption {
  id: string;
  name: string;
  detail: string;
  kind: "debater" | "judge";
}

export interface DiagnosticsReport {
  providers: Array<{ id: string; primary: string; fast: string; tpm: number; exhaustedForMs: number }>;
  tts: { chars: number; requests: number; audioMs: number; costNanos: number };
  sttConfigured: boolean;
  ttsConfigured: boolean;
}

/** Cheap, no network: what is configured and what has been spent. */
export function report(): DiagnosticsReport {
  return {
    providers: providerStatus(),
    tts: { ...usage },
    sttConfigured: Boolean(process.env.GROQ_API_KEY),
    ttsConfigured: Boolean(process.env.RUMIK_API_KEY),
  };
}

export function voices(): VoiceOption[] {
  return [
    ...DEBATERS.map((p) => ({
      id: p.id,
      name: p.name,
      detail: `${p.tier} · ${p.institution} · ${p.voice.speaker ?? p.voice.model}`,
      kind: "debater" as const,
    })),
    ...JUDGES.map((j) => ({
      id: j.id,
      name: j.name,
      detail: `${j.competence} · ${j.institution} · ${j.voice.speaker ?? j.voice.model}`,
      kind: "judge" as const,
    })),
  ];
}

export function voiceFor(id: string): VoiceProfile | null {
  return (
    DEBATERS.find((p) => p.id === id)?.voice ?? JUDGES.find((j) => j.id === id)?.voice ?? null
  );
}

/** A line worth hearing: it exercises the debating cadence, not just phonemes. */
export const SAMPLE_LINE =
  "Madam Speaker, the opening government has not told this house who actually pays. " +
  "Point of information — compared to what?";

/** Actually hit the APIs. Costs a little, which is the point of a test. */
export async function runChecks(): Promise<
  Array<{ label: string; ok: boolean; ms: number; detail: string }>
> {
  const results: Array<{ label: string; ok: boolean; ms: number; detail: string }> = [];

  for (const probe of await probeProviders()) {
    results.push({ label: `llm · ${probe.id}`, ok: probe.ok, ms: probe.ms, detail: probe.detail });
  }

  // Rumik, and then Whisper on Rumik's own output — a full audio round trip.
  const started = Date.now();
  let wav: Buffer | null = null;
  try {
    const chunks: SpokenChunk[] = [];
    await speakText(SAMPLE_LINE, { model: "mulberry", speaker: "adam" }, (c) => {
      chunks.push(c);
    });
    wav = chunks[0]?.wav ?? null;
    const ms = chunks.reduce((n, c) => n + c.durationMs, 0);
    results.push({
      label: "tts · rumik",
      ok: Boolean(wav?.length),
      ms: Date.now() - started,
      detail: wav?.length ? `${chunks.length} chunk(s), ${Math.round(ms / 100) / 10}s of audio` : "no audio returned",
    });
  } catch (err) {
    results.push({ label: "tts · rumik", ok: false, ms: Date.now() - started, detail: String(err).slice(0, 180) });
  }

  if (wav?.length) {
    const t = Date.now();
    try {
      const text = await transcribe(wav, "sample.wav");
      results.push({
        label: "stt · whisper",
        ok: Boolean(text),
        ms: Date.now() - t,
        detail: text ? `"${text.slice(0, 90)}"` : "empty transcript",
      });
    } catch (err) {
      results.push({ label: "stt · whisper", ok: false, ms: Date.now() - t, detail: String(err).slice(0, 180) });
    }
  }

  return results;
}

/** Synthesise a sample in one persona's voice and hand back the audio chunks. */
export async function speakSample(
  voiceId: string,
  text: string,
  onChunk: (chunk: SpokenChunk) => void,
): Promise<{ durationMs: number; chars: number }> {
  const voice = voiceFor(voiceId);
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`);
  const line = (text || SAMPLE_LINE).slice(0, 600);
  let durationMs = 0;
  await speakText(line, voice, (chunk) => {
    durationMs += chunk.durationMs;
    onChunk(chunk);
  });
  return { durationMs, chars: line.length };
}

/** Round-trip a microphone recording through exactly the path a speech uses. */
export async function testMicrophone(
  audio: Buffer,
): Promise<{ text: string; ms: number; bytes: number }> {
  const started = Date.now();
  const text = await transcribe(audio, "soundcheck.webm");
  return { text, ms: Date.now() - started, bytes: audio.length };
}
