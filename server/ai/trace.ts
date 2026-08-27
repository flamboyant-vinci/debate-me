// Per-call tracing.
//
// Every LLM call in this app funnels through one function — `post()` in llm.ts —
// which is why this is cheap. Without it, debugging is guesswork: a swallowed 400
// in `extractArguments` once left the argument structure empty for an entire
// session, and only a hand-added console line found it.
//
// Two sinks, both optional and neither required for the app to run:
//   - always: an in-process ring buffer (for #soundcheck) and a JSONL file
//   - if LANGFUSE_* is set: the same records exported to Langfuse
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TraceEntry {
  id: string;
  ts: number;
  /** Which part of the round made this call: speech.plan, judge.call, poi.compose… */
  op: string;
  provider: string;
  model: string;
  role: string;
  /** Who this call was made as, when it belongs to a persona. */
  personaId?: string;
  position?: string;
  promptChars: number;
  promptTokensEst: number;
  completionChars: number;
  maxCompletion: number;
  latencyMs: number;
  status: "ok" | "empty" | "error";
  /** Providers tried and rejected before this one succeeded. */
  fellBackFrom: string[];
  error?: string;
  stream: boolean;
}

const RING_SIZE = 300;
const ring: TraceEntry[] = [];
const TRACE_DIR = join(process.cwd(), "traces");
const FILE_ENABLED = process.env.DEBSOC_TRACE_FILE !== "0";

let dirReady: Promise<unknown> | null = null;

/**
 * The op currently being executed, so a trace can say *why* a call was made
 * rather than only which model served it. Set around a unit of work; nested
 * calls inherit it.
 */
let currentOp = "unknown";
let currentPersona: { personaId?: string; position?: string } = {};

export function withOp<T>(
  op: string,
  ctx: { personaId?: string; position?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const prevOp = currentOp;
  const prevPersona = currentPersona;
  currentOp = op;
  currentPersona = ctx;
  return fn().finally(() => {
    currentOp = prevOp;
    currentPersona = prevPersona;
  });
}

export function record(
  partial: Omit<TraceEntry, "id" | "ts" | "op" | "personaId" | "position">,
): TraceEntry {
  const entry: TraceEntry = {
    id: randomUUID(),
    ts: Date.now(),
    op: currentOp,
    ...currentPersona,
    ...partial,
  };

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  if (FILE_ENABLED) {
    dirReady ??= mkdir(TRACE_DIR, { recursive: true }).catch(() => undefined);
    void dirReady.then(() => {
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      return appendFile(join(TRACE_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n").catch(
        () => undefined,
      );
    });
  }

  void exportToLangfuse(entry);
  return entry;
}

export function recent(limit = 60): TraceEntry[] {
  return ring.slice(-limit).reverse();
}

/** Rolled up for the panel: per provider and per op. */
export function summary() {
  const byProvider = new Map<string, { calls: number; errors: number; empty: number; ms: number }>();
  const byOp = new Map<string, { calls: number; errors: number; empty: number; ms: number }>();

  const bump = (
    map: Map<string, { calls: number; errors: number; empty: number; ms: number }>,
    key: string,
    e: TraceEntry,
  ) => {
    const row = map.get(key) ?? { calls: 0, errors: 0, empty: 0, ms: 0 };
    row.calls += 1;
    row.ms += e.latencyMs;
    if (e.status === "error") row.errors += 1;
    if (e.status === "empty") row.empty += 1;
    map.set(key, row);
  };

  for (const e of ring) {
    bump(byProvider, e.provider, e);
    bump(byOp, e.op, e);
  }

  const shape = (map: Map<string, { calls: number; errors: number; empty: number; ms: number }>) =>
    [...map.entries()]
      .map(([key, r]) => ({
        key,
        calls: r.calls,
        errors: r.errors,
        empty: r.empty,
        avgMs: Math.round(r.ms / Math.max(1, r.calls)),
      }))
      .sort((a, b) => b.calls - a.calls);

  return {
    total: ring.length,
    failovers: ring.filter((e) => e.fellBackFrom.length > 0).length,
    byProvider: shape(byProvider),
    byOp: shape(byOp),
  };
}

// --- Langfuse -------------------------------------------------------------
//
// Optional. Set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (and LANGFUSE_BASE_URL
// for a self-hosted instance) and the same records are exported. Everything above
// keeps working whether or not this is configured.

interface LangfuseLike {
  generation(args: Record<string, unknown>): { end(args?: Record<string, unknown>): void };
  flushAsync?(): Promise<unknown>;
}

let langfuse: LangfuseLike | null = null;
let langfuseTried = false;

async function getLangfuse(): Promise<LangfuseLike | null> {
  if (langfuseTried) return langfuse;
  langfuseTried = true;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return null;
  try {
    const mod = await import("langfuse");
    const Langfuse = (mod as unknown as { Langfuse: new (o: unknown) => LangfuseLike }).Langfuse;
    langfuse = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });
    console.log("[trace] Langfuse export enabled");
    return langfuse;
  } catch (err) {
    console.warn(`[trace] Langfuse unavailable, continuing with local traces: ${String(err).slice(0, 120)}`);
    return null;
  }
}

async function exportToLangfuse(entry: TraceEntry): Promise<void> {
  const client = await getLangfuse();
  if (!client) return;
  try {
    const gen = client.generation({
      name: entry.op,
      model: entry.model,
      startTime: new Date(entry.ts),
      metadata: {
        provider: entry.provider,
        role: entry.role,
        personaId: entry.personaId,
        position: entry.position,
        fellBackFrom: entry.fellBackFrom,
        stream: entry.stream,
        status: entry.status,
      },
      usage: {
        input: entry.promptTokensEst,
        output: Math.ceil(entry.completionChars / 4),
        unit: "TOKENS",
      },
      level: entry.status === "ok" ? "DEFAULT" : "ERROR",
      statusMessage: entry.error,
    });
    gen.end({ endTime: new Date(entry.ts + entry.latencyMs) });
  } catch {
    // Telemetry must never break a round.
  }
}

export async function flushTraces(): Promise<void> {
  await langfuse?.flushAsync?.();
}

export function langfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}
