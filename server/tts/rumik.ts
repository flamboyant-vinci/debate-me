// Rumik Silk TTS. POST /v1/tts returns a 24 kHz mono WAV for up to 2000 chars.
//
// A 7-minute speech is ~6000 characters, so it is chunked into sentence groups
// and synthesised with a small worker pool while the LLM is still writing. Measured
// throughput is ~2.8x realtime (6.5s of audio in 2.3s), which is comfortably enough
// to stay ahead of playback provided we keep two chunks in flight.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { VoiceEmotion, VoiceProfile } from "../../src/shared/types.ts";

/**
 * A momentary shift in delivery that keeps the speaker's identity intact.
 * Waving down a point is dry; a peroration is energetic. Only emotion and
 * intensity move — never gender, accent or timbre, or the voice stops sounding
 * like the same person mid-round.
 */
export interface Mood {
  emotion?: VoiceEmotion;
  intensity?: "low" | "med" | "high";
  pacing?: VoiceProfile["pacing"];
}

/** Build Mulberry's steering sentence from identity plus current mood. */
export function describeVoice(voice: VoiceProfile, mood: Mood = {}): string {
  const parts = [voice.description?.trim().replace(/,\s*$/, "")].filter(Boolean);
  const pacing = mood.pacing ?? voice.pacing;
  const emotion = mood.emotion ?? voice.emotion;
  const intensity = mood.intensity ?? voice.intensity;
  if (pacing) parts.push(`${pacing} pacing`);
  if (emotion) parts.push(intensity ? `${emotion} at ${intensity} intensity` : emotion);
  return parts.join(", ");
}

const ENDPOINT = "https://silk-api.rumik.ai/v1/tts";
const CACHE_DIR = join(process.cwd(), ".tts-cache");
const CACHE_ENABLED = process.env.DEBSOC_TTS_CACHE !== "0";

/** Characters billed since process start, surfaced in the round cost meter. */
export const usage = { chars: 0, requests: 0, audioMs: 0, costNanos: 0 };

if (CACHE_ENABLED) mkdirSync(CACHE_DIR, { recursive: true });

function key(): string {
  const k = process.env.RUMIK_API_KEY;
  if (!k) throw new Error("RUMIK_API_KEY is not set — put it in .env.local");
  return k;
}

function cachePath(text: string, voice: VoiceProfile): string {
  const h = createHash("sha1").update(JSON.stringify({ text, voice })).digest("hex");
  return join(CACHE_DIR, `${h}.wav`);
}

/** Duration of a 16-bit PCM WAV, from its header. */
export function wavDurationMs(buf: Buffer): number {
  try {
    const sampleRate = buf.readUInt32LE(24);
    const byteRate = buf.readUInt32LE(28);
    if (!byteRate || !sampleRate) return 0;
    // Walk chunks to find `data` rather than assuming a 44-byte header.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === "data") return Math.round((size / byteRate) * 1000);
      offset += 8 + size + (size % 2);
    }
  } catch {
    /* fall through */
  }
  return 0;
}

export async function synthesize(
  text: string,
  voice: VoiceProfile,
  mood: Mood = {},
): Promise<Buffer> {
  const clean = text.trim();
  if (!clean) return Buffer.alloc(0);

  const description = describeVoice(voice, mood);
  const cacheKey = { ...voice, description };

  if (CACHE_ENABLED) {
    const p = cachePath(clean, cacheKey);
    if (existsSync(p)) return readFileSync(p);
  }

  const body: Record<string, unknown> = {
    model: voice.model,
    text: clean.slice(0, 2000),
    temperature: 0.6,
  };
  if (voice.model === "mulberry") {
    if (voice.speaker) body.speaker = voice.speaker;
    if (description) body.description = description;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`rumik ${res.status}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`rumik ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const buf = Buffer.from(await res.arrayBuffer());
      usage.chars += clean.length;
      usage.requests += 1;
      usage.audioMs += Number(res.headers.get("x-audio-duration-ms") ?? 0);
      usage.costNanos += Number(res.headers.get("x-usage-cost-nanos") ?? 0);
      if (CACHE_ENABLED) writeFileSync(cachePath(clean, cacheKey), buf);
      return buf;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("rumik synthesis failed");
}

/**
 * Split prose into synthesis chunks: whole sentences, grouped up to ~320 chars.
 * Short groups keep time-to-first-audio low; grouping keeps prosody natural.
 */
export function chunkForSpeech(text: string, maxChars = 320): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    // A single monstrous sentence still has to be broken somewhere.
    if (sentence.length > maxChars) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (const piece of sentence.match(new RegExp(`.{1,${maxChars}}(\\s|$)`, "g")) ?? [sentence]) {
        out.push(piece.trim());
      }
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

export interface SpokenChunk {
  seq: number;
  text: string;
  wav: Buffer;
  durationMs: number;
}

/**
 * Consume an async stream of prose, synthesise it chunk-by-chunk with a bounded
 * worker pool, and emit finished audio strictly in order.
 *
 * `onChunk` is awaited, so a caller that paces playback naturally applies
 * backpressure to synthesis.
 */
export async function speakStream(
  textStream: AsyncIterable<string>,
  voice: VoiceProfile,
  onChunk: (chunk: SpokenChunk) => Promise<void> | void,
  opts: { concurrency?: number; signal?: AbortSignal; mood?: Mood } = {},
): Promise<string> {
  const concurrency = opts.concurrency ?? 2;
  const pending: Array<Promise<SpokenChunk>> = [];
  let seq = 0;
  let full = "";
  let buffer = "";
  let emitted = 0;

  const drain = async (keep: number) => {
    while (pending.length - emitted > keep) {
      const chunk = await pending[emitted];
      emitted += 1;
      if (opts.signal?.aborted) return;
      await onChunk(chunk);
    }
  };

  const enqueue = (text: string) => {
    const mySeq = seq++;
    pending.push(
      synthesize(text, voice, opts.mood).then((wav) => ({
        seq: mySeq,
        text,
        wav,
        durationMs: wavDurationMs(wav),
      })),
    );
  };

  for await (const delta of textStream) {
    if (opts.signal?.aborted) break;
    full += delta;
    buffer += delta;
    // Emit as soon as we have a complete sentence group.
    const groups = chunkForSpeech(buffer);
    if (groups.length > 1) {
      const ready = groups.slice(0, -1);
      buffer = groups[groups.length - 1];
      for (const g of ready) enqueue(g);
      await drain(concurrency);
    }
  }
  if (buffer.trim() && !opts.signal?.aborted) enqueue(buffer);
  await drain(0);
  return full;
}

/** Synthesise a complete, already-written passage (oral adjudication, POIs). */
export async function speakText(
  text: string,
  voice: VoiceProfile,
  onChunk: (chunk: SpokenChunk) => Promise<void> | void,
  opts: { concurrency?: number; signal?: AbortSignal; mood?: Mood } = {},
): Promise<string> {
  async function* once() {
    yield text;
  }
  return speakStream(once(), voice, onChunk, opts);
}
