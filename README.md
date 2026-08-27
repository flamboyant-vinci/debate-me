# debsoc

A virtual British Parliamentary debating room. You take one seat and speak into your
microphone; the other seven speakers and the adjudication panel are AI, with names,
voices, institutions and genuinely different levels of competence. The interface is a
Discord server, because that is where circuit debating actually happens.

## Running it

```bash
npm run check     # smoke-test Groq and Rumik before you rely on them
npm run dev       # http://localhost:3000
```

`.env.local` needs:

```
GROQ_API_KEY=...     # speeches, prep chat, adjudication, and Whisper for your mic
RUMIK_API_KEY=...    # Rumik Silk TTS — every speaker's voice
```

Optionally, a backup so a round survives Groq running dry. Either one works; both are
OpenAI-compatible and serve the same gpt-oss-120b:

```
# A LiteLLM proxy — openclaw/server/litellm already publishes cf/gpt-oss-120b
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_API_KEY=...
LITELLM_MODEL=cf/gpt-oss-120b

# …or Cloudflare Workers AI directly
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_MODEL=@cf/openai/gpt-oss-120b
```

Providers are tried in order — Groq, then LiteLLM, then Cloudflare — and a provider
that reports a daily exhaustion is skipped for half an hour rather than retried. On
startup the server logs the chain it resolved (`[llm] providers: groq → litellm`), and
`#soundcheck` shows it live. Speech-to-text stays on Groq; only chat fails over.

## #soundcheck

A test channel, available before and during a round. It exercises the same code a
round uses, so problems surface before you commit ninety minutes to one:

- **Voices** — audition any of the 21 debaters and adjudicators, with your own text.
  This is the fastest way to judge whether a persona's voice suits them.
- **Microphone** — records a segment and transcribes it through Whisper. What comes
  back is literally what the adjudicators will read.
- **Providers and APIs** — which models are configured and in what order, remaining
  quota, characters synthesised, and a live check that calls every provider,
  synthesises a line and transcribes it back.

Microphone permission is requested in the lobby rather than mid-speech, so the
browser prompt never lands while your speech clock is running. The mic is only held
open while you actually have the floor.

You can leave a round at any time — "Leave" in the debate room header, or the button
in the corner elsewhere. Everything stops immediately and nothing is recorded.

## Provider latency

Measured with `scripts/bench-providers.ts`, on a prompt the size of a real mid-round
speech prompt. The number that matters is words/second against the ~2.0 the TTS
voices actually deliver — generation has to stay ahead of playback.

| | plan call | speech call | vs delivery |
|---|---|---|---|
| groq · gpt-oss-120b + qwen | ~2.2s | ~1.5s | far ahead |
| litellm/cf · llama-3.3-70b + gpt-oss-120b | 2.8-4.1s | 4.9-13.2s, 266-405 words | 10-41x realtime |

Two findings worth keeping:

- **Cloudflare is fast enough.** Speech generation runs 10-41x realtime, comfortably
  ahead of playback. An earlier reading that suggested otherwise was measuring the
  wrong call.
- **The plan call is what to watch.** `cf/gpt-oss-120b` writes the JSON plan in
  27-87 seconds — wildly variable and enough to stall a round on its own.
  `cf/llama-3.3-70b` does the same job in 2.8-4.1s, which is why `LITELLM_FAST_MODEL`
  points at it. If you add another backup, benchmark its plan call before trusting it.

## What a round looks like

1. **Draw** — you are placed in a position (or pick one), seven AI debaters fill the
   rest of the table, and a panel of one or three adjudicators is assigned.
2. **Motion release** — from a bank of twenty motions, with info slides where the
   motion needs one. Recently used motions are skipped.
3. **Prep** — fifteen minutes on the clock in `#team-prep`. Your AI partner opens with
   a case line and a burden split, argues back when you propose something weak, and
   keeps thinking out loud if you go quiet. What you agree here is fed into their
   actual speech.
4. **The round** — eight speeches in BP order, seven minutes each, protected time at
   both ends. Take the floor and speak; Whisper transcribes you live. AI opponents rise
   on points of information and you accept or wave them down; you can rise during
   theirs and they decide in character. Each AI speech is generated against everything
   said so far and spoken aloud in that persona's voice.
5. **Deliberation** — each judge reaches an independent call, then the panel argues it
   out in `#judges-deliberation` where you can watch.
6. **Results** — ranking, speaker scores on the 50–100 scale, a spoken oral
   adjudication from the chair, and written feedback quoting what you actually said.

Elo, speaker averages and full transcripts persist to `debsoc.db`; see `/circuit`.

**Fast round** (3 min prep, 2 min speeches) exercises the identical machinery at a
fraction of the time and TTS cost. Use it for drilling a position or checking setup.

## Architecture

One Node process. `server/index.ts` is a Next.js custom server hosting Socket.IO; the
browser is a thin renderer and audio device, and the server is authoritative over the
clock, the POI windows, speech generation and judging.

```
server/
  index.ts           Next + Socket.IO bootstrap, /api/circuit
  round/machine.ts   the round state machine — phases, clock, POIs, audio pacing
  ai/groq.ts         chat, streaming chat, JSON mode, Whisper
  ai/speech.ts       plan-then-prose speech generation, argument extraction
  ai/partner.ts      prep-room partner and the shared case notes
  ai/poi.ts          POI composition, acceptance decisions, answers
  ai/judge.ts        per-judge calls, deliberation, oral adj, feedback, Elo
  tts/rumik.ts       Silk TTS: sentence chunking, worker pool, cost meter, disk cache
  db/index.ts        node:sqlite — ratings, rounds, transcripts
src/shared/          types, BP format constants and role burdens, the persona roster
src/components/      discord shell, stage, results
src/lib/audio/       gapless WAV playback queue, segmented mic capture
```

No build step for the server: it runs under Node's native TypeScript stripping. No
native modules — SQLite is `node:sqlite`.

### Notes on the tricky parts

**Audio pacing.** Rumik synthesises at roughly 3× realtime, so the server would race
ahead of playback and a seven-minute speech would arrive in two. `round/machine.ts`
holds delivery to at most twelve seconds ahead of the wall clock, which keeps the
timer honest and applies backpressure to synthesis.

**Microphone segmentation.** `MediaRecorder` chunks produced with a timeslice are not
independently decodable — only the first carries the container header — so Whisper
cannot transcribe them one by one. `src/lib/audio/mic.ts` instead records a chain of
short complete recordings, each self-contained.

**Model.** This Groq account carries `openai/gpt-oss-120b` (a reasoning model),
`qwen/qwen3.6-27b` and Whisper — no Llama. Three things about it cost real debugging
time and are worth knowing before you change `server/ai/groq.ts`:

- **Reasoning is billed against `max_completion_tokens`.** A cap sized for the answer
  gets swallowed by the chain of thought, and the response returns `finish_reason:
  "length"` with *empty content and no error*. Reasoning grows with prompt length, so
  early speeches succeeded and later ones silently returned nothing. Headroom is now
  added to every call by effort level rather than tuned per call site.
- **The two models disagree on `reasoning_effort`.** gpt-oss takes `low`/`medium`/
  `high`; qwen takes only `none`/`default`. The wrong one is a hard 400. It is
  translated per model at the point of use.
- **Strict JSON mode is brittle here.** If reasoning eats the budget the model emits
  nothing, and Groq rejects the empty result with a 400 rather than returning it.
  `chatJson` falls back to a plain call and a lenient parse.

**Rate limits.** The free tier allows **8000 tokens per minute, metered per model**,
and one speech cycle can approach that alone. `server/ai/groq.ts` reads the remaining
budget off every response, keeps a per-model bucket, and waits for the window to roll
over before spending, rather than discovering the limit by being refused. Work is
deliberately split across both models — prose and judging on gpt-oss, planning,
deliberation and feedback on qwen — because the buckets meter separately, which
roughly doubles the usable budget.

The limit is also the effective ceiling on a *single* request — prompt plus reserved
completion must fit inside it, or the call is refused with a 413 however often it is
retried — so the completion budget is computed from what is left of the window after
the prompt, never from a fixed number.

On the free tier a round still spends real time waiting on token windows (expect
~30-60s between some speeches). Each adjudicator reads the whole round, so a
three-judge panel costs three windows; `DEBSOC_PANEL` defaults to `auto`, which seats a
solo chair unless `DEBSOC_TPM` says there is budget for more.

A paid tier removes all of this. Set `DEBSOC_TPM` to your real limit and raise
`DEBSOC_MAX_COMPLETION` from its default of 5000, and panels of three come back
automatically.

**Delivery rate.** The Rumik voices speak at **1.85-2.3 words per second** depending on
the persona's voice description (Raj Menon's "rapid technical delivery" really is
faster than Aditya Rao's "measured and deliberate"), well short of the ~2.7 a human
debater manages. The model also overshoots its word target by roughly 17%. So
`targetWords` in `src/shared/bp.ts` is set against the slow end of that range — 640 for
a seven-minute speech, 180 for two minutes — because calibrating to the average meant
every speaker got cut off, which is not what a real round looks like.

Speeches are still cut at time plus grace, measured on committed audio rather than wall
clock so pacing lag cannot mask an overrun. The check runs at sentence boundaries, so a
speaker gets to finish the sentence they are in, as a chair would allow.

**Cost.** A full round is roughly 42k TTS characters. The stage header shows the
running character count, and synthesised audio is cached in `.tts-cache/` so replaying
identical text is free.

## Testing

```bash
npm run check                  # both APIs, ~10s
npm run types                  # tsc --noEmit
node scripts/dry-round.ts fast # drives a whole round headlessly, no microphone

node --env-file=.env.local scripts/probe-judging.ts 3   # just the adjudication path
```

`probe-judging.ts` runs the panel against a synthetic round, so adjudication changes
can be checked in a minute rather than by sitting through a full one.

**Quota.** The free tier also caps **200,000 tokens per day**. A fast round costs
roughly 30-40k, so expect two or three rounds a day before the quota resets; a daily
exhaustion fails immediately with a clear message rather than retrying.
