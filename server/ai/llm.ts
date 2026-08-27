// Language model access, across more than one provider.
//
// Groq is fast and free but capped hard: 8000 tokens per minute per model and
// 200k per day, which is two or three rounds. When it runs dry the round should
// carry on somewhere else rather than collapsing, so calls fail over to a backup
// provider — a LiteLLM proxy or Cloudflare Workers AI, both OpenAI-compatible —
// serving the same gpt-oss-120b.
//
// Whisper stays on Groq; only chat fails over.

import * as trace from "./trace.ts";

export type ReasoningEffort = "low" | "medium" | "high";
export type Role = "primary" | "fast";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Which of the provider's models to use. Defaults to "primary". */
  role?: Role;
  /** Explicit model id, overriding `role`. Rarely needed. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Ask for a JSON object back and parse it. */
  json?: boolean;
  signal?: AbortSignal;
}

/**
 * How a model spells `reasoning_effort`. gpt-oss on Groq takes low/medium/high,
 * qwen takes only none/default, and sending the wrong one is a hard 400. Backup
 * providers omit it entirely — Workers AI exposes reasoning differently and an
 * unknown parameter is not worth a failed round.
 */
type EffortStyle = "gpt-oss" | "qwen" | "omit";

interface Provider {
  id: string;
  baseUrl: string;
  apiKey: string;
  models: Record<Role, string>;
  effort: Record<Role, EffortStyle>;
  /** Tokens per minute, if the provider meters that way. */
  tpm: number;
  /** Set when the provider reports a daily exhaustion; skipped until then. */
  exhaustedUntil: number;
}

function buildProviders(): Provider[] {
  const list: Provider[] = [];

  if (process.env.GROQ_API_KEY) {
    list.push({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      models: {
        primary: process.env.DEBSOC_MODEL ?? "openai/gpt-oss-120b",
        fast: process.env.DEBSOC_FAST_MODEL ?? "qwen/qwen3.6-27b",
      },
      effort: { primary: "gpt-oss", fast: "qwen" },
      tpm: Number(process.env.DEBSOC_TPM ?? 8000),
      exhaustedUntil: 0,
    });
  }

  // Google, via its OpenAI-compatible endpoint. Fast and with a far more generous
  // free tier than Groq's 200k/day, so it sits ahead of Cloudflare in the chain.
  if (process.env.GEMINI_API_KEY) {
    list.push({
      id: "gemini",
      baseUrl:
        process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      models: {
        primary: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
        fast: process.env.GEMINI_FAST_MODEL ?? "gemini-3.1-flash-lite",
      },
      effort: { primary: "omit", fast: "omit" },
      tpm: Number(process.env.GEMINI_TPM ?? 250_000),
      exhaustedUntil: 0,
    });
  }

  // A LiteLLM proxy, e.g. the one in openclaw/server/litellm which already
  // publishes cf/gpt-oss-120b backed by Cloudflare Workers AI.
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
    const model = process.env.LITELLM_MODEL ?? "cf/gpt-oss-120b";
    list.push({
      id: "litellm",
      baseUrl: process.env.LITELLM_BASE_URL.replace(/\/$/, ""),
      apiKey: process.env.LITELLM_API_KEY,
      models: { primary: model, fast: process.env.LITELLM_FAST_MODEL ?? model },
      effort: { primary: "omit", fast: "omit" },
      tpm: Number(process.env.LITELLM_TPM ?? 200_000),
      exhaustedUntil: 0,
    });
  }

  // A second lane through the same proxy, on a different backend entirely, so an
  // outage at Cloudflare is not an outage for the round. DeepInfra measured fastest
  // of the proxy backends.
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY && process.env.LITELLM_ALT_MODEL) {
    const model = process.env.LITELLM_ALT_MODEL;
    list.push({
      id: "litellm-alt",
      baseUrl: process.env.LITELLM_BASE_URL.replace(/\/$/, ""),
      apiKey: process.env.LITELLM_API_KEY,
      models: { primary: model, fast: process.env.LITELLM_ALT_FAST_MODEL ?? model },
      effort: { primary: "omit", fast: "omit" },
      tpm: Number(process.env.LITELLM_TPM ?? 200_000),
      exhaustedUntil: 0,
    });
  }

  // OpenCode Go — a flat monthly subscription over curated open models, on its
  // own endpoint (/zen/go/v1, NOT /zen/v1, which is the separate credit-based Zen
  // product and answers CreditsError for every model). Already paid for, and
  // gpt-5.6-luna was the only model tested that reliably hits the word target,
  // so it leads the chain.
  if (process.env.OPENCODE_API_KEY) {
    list.push({
      id: "opencode",
      baseUrl: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
      apiKey: process.env.OPENCODE_API_KEY,
      models: {
        primary: process.env.OPENCODE_MODEL ?? "gpt-5.6-luna",
        fast: process.env.OPENCODE_FAST_MODEL ?? "mimo-v2.5",
      },
      effort: { primary: "omit", fast: "omit" },
      tpm: Number(process.env.OPENCODE_TPM ?? 100_000),
      exhaustedUntil: 0,
    });
  }

  // Cloudflare Workers AI directly, no proxy in between.
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    const model = process.env.CLOUDFLARE_MODEL ?? "@cf/openai/gpt-oss-120b";
    list.push({
      id: "cloudflare",
      baseUrl:
        process.env.CLOUDFLARE_OPENAI_BASE?.replace(/\/$/, "") ??
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      models: { primary: model, fast: process.env.CLOUDFLARE_FAST_MODEL ?? model },
      effort: { primary: "omit", fast: "omit" },
      tpm: Number(process.env.CLOUDFLARE_TPM ?? 200_000),
      exhaustedUntil: 0,
    });
  }

  // Preference order. Gemini leads by default: measured faster than Groq on the
  // plan call and with a far more generous free tier, so a round is much less
  // likely to stall. Override with DEBSOC_PROVIDER_ORDER=groq,gemini,litellm.
  const order = (process.env.DEBSOC_PROVIDER_ORDER ?? "opencode,gemini,litellm,litellm-alt,groq,cloudflare")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  list.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return list;
}

const PROVIDERS = buildProviders();

if (!PROVIDERS.length) {
  console.warn("[llm] No provider configured — set GROQ_API_KEY in .env.local");
} else {
  console.log(`[llm] providers: ${PROVIDERS.map((p) => p.id).join(" → ")}`);
}

/** Providers currently worth trying, in preference order. */
function available(): Provider[] {
  const now = Date.now();
  const live = PROVIDERS.filter((p) => p.exhaustedUntil < now);
  // If everything is exhausted, try them all anyway rather than refusing outright.
  return live.length ? live : PROVIDERS;
}

export function providerNames(): string[] {
  return PROVIDERS.map((p) => p.id);
}

export interface ProviderStatus {
  id: string;
  primary: string;
  fast: string;
  tpm: number;
  /** Milliseconds until this provider is retried, if it reported a daily limit. */
  exhaustedForMs: number;
}

export function providerStatus(): ProviderStatus[] {
  const now = Date.now();
  return PROVIDERS.map((p) => ({
    id: p.id,
    primary: p.models.primary,
    fast: p.models.fast,
    tpm: p.tpm,
    exhaustedForMs: Math.max(0, p.exhaustedUntil - now),
  }));
}

/** Ask each provider for one short completion, so the test channel can prove reachability. */
export async function probeProviders(): Promise<
  Array<{ id: string; ok: boolean; ms: number; detail: string }>
> {
  const results = [];
  for (const provider of PROVIDERS) {
    const started = Date.now();
    try {
      const body = buildBody(
        provider,
        [{ role: "user", content: "Reply with exactly: READY" }],
        { maxTokens: 400, reasoningEffort: "low" },
        false,
      );
      const res = await postTo(provider, body);
      const json = await res.json();
      const content = (json.choices?.[0]?.message?.content ?? "").trim();
      results.push({
        id: provider.id,
        ok: Boolean(content),
        ms: Date.now() - started,
        detail: content ? `${body.model} · "${content.slice(0, 40)}"` : `${body.model} · empty reply`,
      });
    } catch (err) {
      results.push({
        id: provider.id,
        ok: false,
        ms: Date.now() - started,
        detail: String(err).slice(0, 180),
      });
    }
  }
  return results;
}

/** Backwards-compatible names for the Groq models, used by the smoke test. */
export const MODEL = process.env.DEBSOC_MODEL ?? "openai/gpt-oss-120b";
export const FAST_MODEL = process.env.DEBSOC_FAST_MODEL ?? "qwen/qwen3.6-27b";

/**
 * gpt-oss bills its chain of thought against `max_completion_tokens`, so a cap
 * sized for the answer alone can be swallowed whole by reasoning — the response
 * then comes back with `finish_reason: "length"` and empty content. Reasoning
 * grows with prompt length, so this headroom is added to every call rather than
 * tuned per site.
 */
const REASONING_HEADROOM: Record<ReasoningEffort, number> = {
  low: 2000,
  medium: 5000,
  high: 10000,
};

const MAX_COMPLETION = Number(process.env.DEBSOC_MAX_COMPLETION ?? 5000);

function budget(opts: ChatOptions, messages: ChatMessage[], provider: Provider): number {
  const effort = opts.reasoningEffort ?? "low";
  const want = (opts.maxTokens ?? 2400) + REASONING_HEADROOM[effort];
  const promptTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
  // Prompt plus reserved completion must fit the window, or the call is refused
  // with a 413 however often it is retried.
  const fits = provider.tpm - promptTokens - 400;
  return Math.max(600, Math.min(MAX_COMPLETION, want, fits));
}

function effortValue(style: EffortStyle, effort: ReasoningEffort): string | undefined {
  if (style === "omit") return undefined;
  if (style === "qwen") return effort === "low" ? "none" : "default";
  return effort;
}

/**
 * How many adjudicators the panel may hold. Each judge reads the whole round, so
 * a three-person panel costs three token windows — several minutes on a free
 * tier. "auto" seats a solo chair unless there is budget for more.
 */
export function maxPanelSize(): number {
  const setting = process.env.DEBSOC_PANEL ?? "auto";
  if (setting !== "auto") return Math.max(1, Number(setting) || 1);
  const roomy = PROVIDERS.some((p) => p.tpm > 8000);
  return roomy ? 3 : 1;
}

// --- rate limiting -------------------------------------------------------
//
// Providers report the remaining budget on every response, so rather than
// discovering the limit by being refused, we track it and wait for the window to
// roll over before spending. Buckets are per provider and model, so splitting
// work across models uses each one's separate allowance.

interface Bucket {
  remaining: number;
  resetAt: number;
  /** Serialises callers so two requests cannot both think there is room. */
  chain: Promise<void>;
}

const buckets = new Map<string, Bucket>();

/** Providers format durations as "33.93s", "1m26.4s", "157ms". */
function parseDuration(value: string | null): number {
  if (!value) return 0;
  const ms = /^([\d.]+)ms$/.exec(value);
  if (ms) return Number(ms[1]);
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/([\d.]+)(ms|m|s|h)/g)) {
    const n = Number(amount);
    total += unit === "h" ? n * 3.6e6 : unit === "m" ? n * 60_000 : unit === "s" ? n * 1000 : n;
  }
  return total;
}

function bucketFor(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { remaining: Number.POSITIVE_INFINITY, resetAt: 0, chain: Promise.resolve() };
    buckets.set(key, b);
  }
  return b;
}

class WouldStall extends Error {}

/**
 * Take `needed` tokens from the window, waiting for it to roll over if necessary.
 *
 * When another provider is available, waiting is the wrong trade: a minute of
 * dead air between speeches is worse than a slightly slower backup. So a wait
 * longer than `maxWaitMs` throws instead, and the caller moves down the chain.
 */
async function reserve(
  key: string,
  needed: number,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const bucket = bucketFor(key);
  const wait = bucket.chain.then(async () => {
    while (bucket.remaining < needed && Date.now() < bucket.resetAt) {
      const delay = Math.min(65_000, bucket.resetAt - Date.now() + 500);
      if (signal?.aborted) return;
      if (delay > maxWaitMs) {
        throw new WouldStall(
          `${key} would stall ${Math.round(delay / 1000)}s for its token window`,
        );
      }
      console.log(
        `[llm] ${key}: waiting ${Math.round(delay / 1000)}s for the token window ` +
          `(need ~${needed}, ${bucket.remaining} left)`,
      );
      await new Promise((r) => setTimeout(r, delay));
      bucket.remaining = Number.POSITIVE_INFINITY;
    }
    bucket.remaining -= needed;
  });
  bucket.chain = wait.catch(() => undefined);
  await wait;
}

function observe(key: string, res: Response): void {
  const bucket = bucketFor(key);
  const remaining = res.headers.get("x-ratelimit-remaining-tokens");
  const reset = parseDuration(res.headers.get("x-ratelimit-reset-tokens"));
  if (remaining !== null) bucket.remaining = Number(remaining);
  if (reset) bucket.resetAt = Date.now() + reset;
}

class DailyLimit extends Error {}

interface RequestBody {
  model: string;
  messages: ChatMessage[];
  max_completion_tokens: number;
  [key: string]: unknown;
}

function buildBody(
  provider: Provider,
  messages: ChatMessage[],
  opts: ChatOptions,
  stream: boolean,
): RequestBody {
  const role = opts.role ?? "primary";
  const effort = effortValue(provider.effort[role], opts.reasoningEffort ?? "low");
  return {
    model: opts.model ?? provider.models[role],
    messages,
    temperature: opts.temperature ?? 0.8,
    max_completion_tokens: budget(opts, messages, provider),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** One provider's attempt, with its own retry and rate-limit handling. */
async function postTo(
  provider: Provider,
  body: RequestBody,
  signal?: AbortSignal,
  maxWaitMs = 65_000,
): Promise<Response> {
  const key = `${provider.id}:${body.model}`;
  const needed =
    Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4) +
    body.max_completion_tokens;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    await reserve(key, needed, maxWaitMs, signal);
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      observe(key, res);

      if (res.status === 429) {
        const text = await res.text();
        // A quota exhaustion will not clear inside any retry window worth waiting
        // for, so it moves straight on to the next provider. Providers word this
        // very differently — Groq says "tokens per day", Gemini says "exceeded
        // your current quota" — and matching too narrowly cost 26 seconds of dead
        // air per call before the fallback was reached.
        if (
          /tokens per day|TPD|daily|exceeded your current quota|check your plan and billing|RESOURCE_EXHAUSTED|quota_exceeded|FreeUsageLimit|Insufficient balance|CreditsError/i.test(
            text,
          )
        ) {
          provider.exhaustedUntil = Date.now() + 30 * 60_000;
          throw new DailyLimit(`${provider.id} daily token limit reached: ${text.slice(0, 140)}`);
        }
        const retryAfter =
          parseDuration(res.headers.get("retry-after")) ||
          Number(res.headers.get("retry-after")) * 1000 ||
          parseDuration(res.headers.get("x-ratelimit-reset-tokens")) ||
          8000;
        const delay = Math.min(65_000, retryAfter + 500);
        lastErr = new Error(`${provider.id} 429: ${text.slice(0, 160)}`);
        bucketFor(key).remaining = 0;
        bucketFor(key).resetAt = Date.now() + delay;
        if (delay > maxWaitMs) {
          throw new WouldStall(`${provider.id} rate limited for ${Math.round(delay / 1000)}s`);
        }
        console.log(`[llm] ${key}: rate limited, retrying in ${Math.round(delay / 1000)}s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`${provider.id} ${res.status}: ${(await res.text()).slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`${provider.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return res;
    } catch (err) {
      if (signal?.aborted || err instanceof DailyLimit || err instanceof WouldStall) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${provider.id} request failed`);
}

/** Try each provider in turn; the first that answers wins. */
async function post(
  messages: ChatMessage[],
  opts: ChatOptions,
  stream: boolean,
): Promise<{ res: Response; provider: Provider }> {
  const providers = available();
  if (!providers.length) throw new Error("No LLM provider configured — set GROQ_API_KEY");

  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const fellBackFrom: string[] = [];
  let lastErr: unknown;
  for (const provider of providers) {
    const startedAt = Date.now();
    const isLast = provider === providers[providers.length - 1];
    // Only the last provider in the chain is worth waiting on.
    // Long enough to ride out a short per-minute limit (Gemini's is ~9s), because
    // waiting is far better than the alternative: bailing produced empty speeches.
    const maxWaitMs = isLast ? 65_000 : Number(process.env.DEBSOC_MAX_STALL_MS ?? 20_000);
    try {
      const body = buildBody(provider, messages, opts, stream);
      const res = await postTo(provider, body, opts.signal, maxWaitMs);
      // A streaming body is consumed by the caller, so completion size is
      // recorded as zero here; the caller reports the real figure via
      // `noteCompletion`. Non-streaming calls are amended the same way.
      const entry = trace.record({
        provider: provider.id,
        model: body.model,
        role: opts.role ?? "primary",
        promptChars,
        promptTokensEst: Math.ceil(promptChars / 4),
        completionChars: 0,
        maxCompletion: body.max_completion_tokens,
        latencyMs: Date.now() - startedAt,
        status: "ok",
        fellBackFrom: [...fellBackFrom],
        stream,
      });
      pendingEntry = entry;
      return { res, provider };
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      trace.record({
        provider: provider.id,
        model: provider.models[opts.role ?? "primary"],
        role: opts.role ?? "primary",
        promptChars,
        promptTokensEst: Math.ceil(promptChars / 4),
        completionChars: 0,
        maxCompletion: 0,
        latencyMs: Date.now() - startedAt,
        status: "error",
        fellBackFrom: [...fellBackFrom],
        error: String(err).slice(0, 200),
        stream,
      });
      fellBackFrom.push(provider.id);
      lastErr = err;
      const next = providers[providers.indexOf(provider) + 1];
      console.warn(
        `[llm] ${provider.id} failed${next ? `, falling back to ${next.id}` : " (no fallback left)"}: ` +
          String(err).slice(0, 180),
      );
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all providers failed");
}

/**
 * Some providers hand back the chain of thought inline as a <think> block rather
 * than in a separate field. Left alone, a debater would read its own reasoning
 * aloud, so it is stripped from anything that reaches a speech.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/** The trace row for the in-flight call, so its result can be filled in. */
let pendingEntry: trace.TraceEntry | null = null;

function noteCompletion(chars: number): void {
  if (!pendingEntry) return;
  pendingEntry.completionChars = chars;
  if (chars === 0) pendingEntry.status = "empty";
  pendingEntry = null;
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const { res } = await post(messages, opts, false);
  const json = await res.json();
  const text = stripReasoning((json.choices?.[0]?.message?.content ?? "").trim());
  noteCompletion(text.length);
  return text;
}

/**
 * chat() plus a tolerant JSON parse.
 *
 * Strict JSON mode is brittle on a reasoning model: if the chain of thought eats
 * the completion budget the model emits nothing, and the provider rejects the
 * empty result with a 400 `json_validate_failed` rather than returning it. So a
 * failure falls back to a plain call — where empty output is merely empty —
 * asking for JSON in the prompt and parsing it leniently.
 */
export async function chatJson<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  try {
    const raw = await chat(messages, { ...opts, json: true });
    if (raw) return parseJson<T>(raw);
  } catch (err) {
    // Only a JSON-shaped failure is worth a second attempt. A rate-limit or an
    // oversized request fails identically in plain mode.
    const message = String(err);
    if (/\b(429|413)\b|rate limit|too large|daily/i.test(message)) throw err;
    console.warn(`[llm] JSON mode failed, retrying in plain mode: ${message.slice(0, 160)}`);
  }
  const retry = await chat(
    [
      ...messages,
      {
        role: "user",
        content: "Reply with the JSON object only. No prose before or after, no code fences.",
      },
    ],
    { ...opts, json: false },
  );
  return parseJson<T>(retry);
}

export function parseJson<T>(raw: string): T {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error(`Could not parse model JSON: ${cleaned.slice(0, 300)}`);
  }
}

/**
 * Streaming chat. Yields content deltas as they arrive so a speech can begin
 * being synthesised before the model has finished writing it.
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string> {
  const { res } = await post(messages, opts, true);
  if (!res.body) throw new Error("no response body to stream");
  const streamEntry = pendingEntry;
  pendingEntry = null;
  let emitted = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // A <think> block can arrive split across any number of deltas, so reasoning is
  // filtered with a running state machine rather than a regex over the whole text.
  let inThink = false;
  let pending = "";
  const OPEN = "<think>";
  const CLOSE = "</think>";

  /** Emit whatever is safely outside a reasoning block, holding back partial tags. */
  function* filter(chunk: string): Generator<string> {
    pending += chunk;
    while (pending) {
      if (inThink) {
        const end = pending.toLowerCase().indexOf(CLOSE);
        if (end === -1) {
          // Keep only enough to recognise a close tag split across deltas.
          pending = pending.slice(-CLOSE.length);
          return;
        }
        pending = pending.slice(end + CLOSE.length);
        inThink = false;
        continue;
      }
      const start = pending.toLowerCase().indexOf(OPEN);
      if (start === -1) {
        // Hold back a possible partial opening tag at the tail.
        const keep = Math.min(pending.length, OPEN.length - 1);
        const safe = pending.slice(0, pending.length - keep);
        const tail = pending.slice(pending.length - keep);
        if (!OPEN.startsWith(tail.toLowerCase())) {
          if (pending) yield pending;
          pending = "";
          return;
        }
        if (safe) yield safe;
        pending = tail;
        return;
      }
      if (start > 0) yield pending.slice(0, start);
      pending = pending.slice(start + OPEN.length);
      inThink = true;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        if (!inThink && pending) {
          emitted += pending.length;
          yield pending;
        }
        if (streamEntry) {
          streamEntry.completionChars = emitted;
          if (emitted === 0) streamEntry.status = "empty";
        }
        return;
      }
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) {
          for (const piece of filter(delta as string)) {
            emitted += piece.length;
            yield piece;
          }
        }
      } catch {
        // keep-alive or partial frame; ignore
      }
    }
  }
  if (!inThink && pending) {
    emitted += pending.length;
    yield pending;
  }
  if (streamEntry) {
    streamEntry.completionChars = emitted;
    if (emitted === 0) streamEntry.status = "empty";
  }
}

/**
 * Speech-to-text, with a fallback.
 *
 * This is the one call the human's own speech depends on, so a single provider
 * here means a Groq outage leaves you unable to debate at all. Groq is tried
 * first because it is roughly six times faster (~0.6s vs ~3.6s), then the
 * LiteLLM proxy's Whisper.
 */
interface SttTarget {
  id: string;
  url: string;
  key: string;
  model: string;
}

function sttTargets(): SttTarget[] {
  const targets: SttTarget[] = [];
  if (process.env.GROQ_API_KEY) {
    targets.push({
      id: "groq",
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      key: process.env.GROQ_API_KEY,
      model: "whisper-large-v3-turbo",
    });
  }
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY && process.env.LITELLM_STT_MODEL) {
    targets.push({
      id: "litellm",
      url: `${process.env.LITELLM_BASE_URL.replace(/\/$/, "")}/audio/transcriptions`,
      key: process.env.LITELLM_API_KEY,
      model: process.env.LITELLM_STT_MODEL,
    });
  }
  return targets;
}

export async function transcribe(
  audio: Buffer,
  filename = "chunk.webm",
  prompt?: string,
): Promise<string> {
  const targets = sttTargets();
  if (!targets.length) throw new Error("No speech-to-text provider configured");

  let lastErr: unknown;
  for (const target of targets) {
    const startedAt = Date.now();
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)]), filename);
      form.append("model", target.model);
      form.append("response_format", "json");
      form.append("language", "en");
      if (prompt) form.append("prompt", prompt.slice(-800));

      const res = await fetch(target.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.key}` },
        body: form,
      });
      if (!res.ok) throw new Error(`${target.id} ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const json = await res.json();
      const text = ((json.text as string) ?? "").trim();
      trace.record({
        provider: `stt:${target.id}`,
        model: target.model,
        role: "stt",
        promptChars: audio.length,
        promptTokensEst: 0,
        completionChars: text.length,
        maxCompletion: 0,
        latencyMs: Date.now() - startedAt,
        status: text ? "ok" : "empty",
        fellBackFrom: targets.slice(0, targets.indexOf(target)).map((t) => `stt:${t.id}`),
        stream: false,
      });
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`[stt] ${target.id} failed: ${String(err).slice(0, 140)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("transcription failed");
}
