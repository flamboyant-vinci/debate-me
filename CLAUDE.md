# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A single-player British Parliamentary debating simulator. You (the human) take one
of eight speaking positions; the other seven debaters, the adjudication panel, and
your own prep-room partner are all AI, each a named persona with a fixed voice,
skill tier, and personality. The UI is a Discord-style server (channels, voice room,
member list) because that's the natural shape for a debating circuit's prep-room and
result-announcement flow.

## Commands

```bash
npm run dev                        # dev server, http://localhost:3000, restarts on server/ changes
npm run build && npm start         # production build + run (server code isn't watched in prod)
npm run types                      # tsc --noEmit — run after any non-trivial change
npm run lint

npm run check                      # smoke-test Groq/Rumik keys before relying on them (~10s)
node --env-file=.env.local scripts/probe-failover.ts        # verify provider chain failover
node --env-file=.env.local scripts/probe-judging.ts 3       # adjudication only, synthetic round, ~1 min
node --env-file=.env.local scripts/bench-providers.ts 3     # latency of plan+speech calls per provider
node scripts/dry-round.ts fast     # drives a full round headlessly (no browser/mic), ~3-5 min
```

There is no unit test suite. `dry-round.ts` and `probe-judging.ts` are the verification tools —
prefer `probe-judging.ts` when only adjudication logic changed, since it skips the ~20-minute
round and calls `judgeRound`/`deliberate`/`oralAdjudication`/`writtenFeedback` directly against a
synthetic transcript.

**Server code has no build step.** `server/**/*.ts` runs directly under Node's native TypeScript
stripping (`node --env-file=.env.local server/index.ts`), imported with explicit `.ts` extensions.
Only `next build` compiles the client. When editing server files under `npm run dev`, the
`--watch-path=./server` flag restarts the process automatically.

## Architecture

**One Node process** (`server/index.ts`): a Next.js custom server hosting Socket.IO. The browser
is a thin renderer and audio I/O device; the server is authoritative over the round clock, POI
windows, speech generation, and judging. All client↔server traffic is Socket.IO events, not REST
(except `GET /api/circuit` for the standings page).

**The round is a hand-written state machine**, not a library: `server/round/machine.ts`'s `Round`
class walks `LOBBY → DRAW → MOTION → PREP → ROUND → DELIBERATION → RESULTS`. It owns the speech
clock, decides POI legality, drives speech generation and TTS playback pacing, and persists
results. `RoundState` (`src/shared/types.ts`) is pushed to the client wholesale on every change;
there's no client-side reducer — the browser just renders what it's given.

**LLM access goes through one chokepoint**: `server/ai/llm.ts`'s `post()`. Every other AI module
(`speech.ts`, `judge.ts`, `poi.ts`, `partner.ts`) calls `chat()` / `chatJson()` / `chatStream()`
from there — never a provider SDK directly. This matters for two reasons:

1. **Provider failover is chain-based, not per-call.** Providers are tried in order
   (`DEBSOC_PROVIDER_ORDER`, default `opencode,gemini,litellm,litellm-alt,groq,cloudflare`), each
   with its own token-bucket rate limiter parsed from response headers. A provider that reports a
   quota exhaustion (wording differs wildly per vendor — see the regex in `llm.ts`) is skipped for
   30 min rather than retried. Non-final providers give up after `DEBSOC_MAX_STALL_MS` (default
   20s) and fail over; only the last provider in the chain is worth waiting the full 65s for.
2. **Every call is traced automatically** (`server/ai/trace.ts`) — provider, model, latency,
   prompt/completion size, failover hops, status. No opt-in needed; it's built into `post()`.
   Traces are visible live in the `#soundcheck` channel and exported to Langfuse if
   `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set. **This trace panel is the primary debugging
   tool for anything that looks like "the AI said nothing" or "a speech took forever"** — check it
   before adding new logging.

**Reasoning-model gotchas baked into `llm.ts` — do not re-simplify these away:**
- Reasoning-capable models (gpt-oss, etc.) bill their chain-of-thought against
  `max_completion_tokens`. A cap sized for the answer alone gets silently swallowed by reasoning,
  returning `finish_reason: "length"` with **empty content and no error**. `REASONING_HEADROOM`
  adds slack per effort level; `budget()` also caps the request below the provider's per-minute
  limit, since an over-budget request 413s forever.
- `reasoning_effort` vocabulary differs per model family (`low`/`medium`/`high` vs `none`/`default`
  vs omitted entirely) — see `effortFor()`. Sending the wrong one is a hard 400.
- Some providers leak `<think>...</think>` inline in streamed content instead of a separate field.
  `chatStream()` filters it with a small state machine (not a naive regex) because the tag can
  split across arbitrary delta boundaries.
- `chatJson()` falls back to a plain-text call + lenient parse if strict JSON mode fails, but
  *not* on a 429/413 — those fail identically in plain mode, so retrying just burns another
  window.

**Debating quality lives in prompt content, not code**, split across two independently-tunable
standards in `src/shared/bp.ts`: `ANALYSIS_STANDARD` (setting the test/burden, "even if" layering,
turns, multi-level rebuttal, comparative weighing — what a speech *argues*) and
`DELIVERY_STANDARD` (narrative through-line, varied rhythm, no repeated stock transitions — how it
*sounds*). `TIER_LAYERS` (`src/shared/roster.ts`) gates which of the analysis layers a persona's
skill tier can actually reach — a novice is structurally denied "even if" reasoning, not just
told to write worse. `server/ai/speech.ts`'s `planSpeech()` also scales how many layers it
attempts to the speaker's actual word budget (`wordsForSpeech()`), because cramming a full
even-if/turn/counter-model set into a 2-minute speech produces compressed notes, not prose.

**Speech pacing is per-persona and derived from measured data, not a flat WPM constant.** Each
`Persona.voice` (`src/shared/roster.ts`) carries a Rumik Mulberry `pacing` value
(`conversational`→`very_fast`) tied to skill tier, and `PACING_WPS` in `bp.ts` holds the actually
measured words/sec for each step. `wordsForSpeech()` derives the word budget from a speaker's own
pace, and `machine.ts` anchors the speech clock to the moment audio actually starts playing
(`audioStartedAt`), not when generation began — generation can stall for the rate-limit window,
and starting the clock then desyncs the timer from what's audible.

**Rumik TTS** (`server/tts/rumik.ts`): sentence-chunked, synthesized with a small concurrent
worker pool while the LLM is still streaming, cached to `.tts-cache/` by (text, voice, mood)
hash. `describeVoice()` composes the Mulberry `description` string from a persona's fixed
identity (accent/timbre/age — never changes) plus an optional `Mood` override (emotion/intensity/
pacing — used for moments like waving down a POI vs. accepting one, so delivery shifts without
the voice sounding like a different person).

**Persona/roster data lives in `src/shared/roster.ts`** (not `server/`) specifically so the
browser can render tiers/colors/voice info without duplicating it — `server/data/personas.ts` is
a thin re-export for server-side imports.

**`node:sqlite`**, not `better-sqlite3` — chosen to avoid a native module install (npm's
`allow-scripts` gate blocks postinstall scripts in this environment). `server/db/index.ts` holds
Elo ratings, round history, and full transcripts; `db.saveRound()` also records the motion so
`pickMotion()` can avoid recent repeats.

## Environment

`.env.local` (see `README.md` for the full annotated list): `RUMIK_API_KEY` is required. At least
one LLM provider is required — current setup uses `GEMINI_API_KEY`, `GROQ_API_KEY`,
`OPENCODE_API_KEY` (note: OpenCode **Go** uses `/zen/go/v1`, a different endpoint and product from
OpenCode **Zen** `/zen/v1` — the wrong one 402s on every model), and `LITELLM_*` pointing at a
local LiteLLM proxy (`~/.local/share/litellm/config.yaml`, shared with other projects — back up
before editing, restart with `venv/bin/litellm --config config.yaml --port 4000`).
