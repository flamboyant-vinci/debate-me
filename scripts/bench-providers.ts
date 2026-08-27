// Head-to-head latency benchmark of every configured provider, on the two calls
// that actually gate a round: the JSON plan, and the streamed speech.
//
// The number that matters is the last column. Rumik delivers speech at ~1.9-2.1
// words/second, so generation must exceed that to stay ahead of playback. Below
// it, the speaker runs out of words mid-speech and the round stalls.
//
//   node --env-file=.env.local scripts/bench-providers.ts [runs]

const RUNS = Number(process.argv[2] ?? 1);
const DELIVERY_WPS = 2.0;

interface Target {
  label: string;
  base: string;
  key: string;
  /** The model that writes the spoken prose (the app's "primary" role). */
  model: string;
  /** The model that writes the JSON plan (the app's "fast" role). */
  planModel: string;
  effort?: string;
}

const targets: Target[] = [];
if (process.env.GROQ_API_KEY) {
  targets.push({
    label: "groq",
    base: "https://api.groq.com/openai/v1",
    key: process.env.GROQ_API_KEY,
    model: process.env.DEBSOC_MODEL ?? "openai/gpt-oss-120b",
    planModel: process.env.DEBSOC_FAST_MODEL ?? "qwen/qwen3.6-27b",
    effort: "low",
  });
}
if (process.env.OPENCODE_API_KEY) {
  targets.push({
    label: "opencode-go",
    base: process.env.OPENCODE_BASE_URL ?? "https://opencode.ai/zen/go/v1",
    key: process.env.OPENCODE_API_KEY,
    model: process.env.OPENCODE_MODEL ?? "gpt-5.6-luna",
    planModel: process.env.OPENCODE_FAST_MODEL ?? "mimo-v2.5",
  });
}
if (process.env.GEMINI_API_KEY) {
  targets.push({
    label: "gemini",
    base: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    planModel: process.env.GEMINI_FAST_MODEL ?? "gemini-3.1-flash-lite",
  });
}
if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
  targets.push({
    label: "litellm/cf",
    base: process.env.LITELLM_BASE_URL.replace(/\/$/, ""),
    key: process.env.LITELLM_API_KEY,
    model: process.env.LITELLM_MODEL ?? "cf/gpt-oss-120b",
    planModel: process.env.LITELLM_FAST_MODEL ?? process.env.LITELLM_MODEL ?? "cf/gpt-oss-120b",
  });
}
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
  targets.push({
    label: "cf-direct",
    base:
      process.env.CLOUDFLARE_OPENAI_BASE?.replace(/\/$/, "") ??
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
    key: process.env.CLOUDFLARE_API_TOKEN,
    model: process.env.CLOUDFLARE_MODEL ?? "@cf/openai/gpt-oss-120b",
    planModel: process.env.CLOUDFLARE_FAST_MODEL ?? process.env.CLOUDFLARE_MODEL ?? "@cf/openai/gpt-oss-120b",
  });
}

// A prompt the size of a real mid-round speech prompt (~3.5k chars), so the
// measurement reflects what the app actually sends, not a toy request.
const MOTION = "This House would ban social media for under-16s";
const DIGEST = [
  `MOTION: ${MOTION}`,
  "",
  "THE TABLE:",
  "  PM (Opening Government) — Raj Menon",
  "  LO (Opening Opposition) — You [the human]",
  "  DPM (Opening Government) — Aditya Rao",
  "  DLO (Opening Opposition) — Ben Cartwright",
  "  MG (Closing Government) — James Whitfield",
  "  MO (Closing Opposition) — Elena Petrova",
  "  GW (Closing Government) — Marcus Hall",
  "  OW (Closing Opposition) — Yusuf Karim",
  "",
  "SPEECHES SO FAR:",
  "--- PM (Opening Government), Raj Menon ---",
  "  • Children cannot consent to engagement-optimised design — mechanism: feeds tuned by behavioural teams against developing brains — impact: compulsive use, displaced sleep",
  "  • A legal norm shifts platform incentives — mechanism: default rules force design change — impact: structural, beyond individual enforcement",
  "  Transcript: Madam Speaker, the question this round turns on is whether the state may intervene to protect children who cannot meaningfully consent. I define social media as public-facing platforms that allow users to create and share content, and under-sixteens as anyone below that age. Let me be clear about who pays the cost of the status quo. " +
    "The mechanism is straightforward: engagement is optimised by teams of behavioural scientists, tested continuously against millions of users, and deployed against brains that cannot yet model long-run consequences. That produces compulsive use and displaced sleep, and it falls hardest on the children with least support at home.",
  "",
  "--- LO (Opening Opposition), You ---",
  "  Transcript: Opposition accepts the definition but rejects the burden government has set itself. They must show the ban works, not merely that harm exists. Enforcement is trivially circumvented by age misreporting, and the children pushed off mainstream platforms land in unmoderated spaces instead.",
].join("\n");

const SYSTEM =
  "You are competing in a British Parliamentary debate round. Four teams of two: Opening Government " +
  "(PM, DPM), Opening Opposition (LO, DLO), Closing Government (MG, GW), Closing Opposition (MO, OW). " +
  "You are the Deputy Prime Minister for Opening Government. Rebut the Leader of Opposition head-on, " +
  "defend the Prime Minister's material against the specific attacks made, and add one new substantive " +
  "argument. Deliver the speech ALOUD: spoken word only, no markdown, no headings, no stage directions. " +
  "Signpost verbally. HARD LIMIT: 220 words.";

/** Same per-model translation the app does — qwen rejects low/medium/high. */
function effortFor(model: string, effort: "low" | "medium"): Record<string, string> {
  if (model.startsWith("qwen")) return { reasoning_effort: effort === "low" ? "none" : "default" };
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: effort };
  return {};
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Strip inline reasoning the way the app does, so word counts are comparable. */
function strip(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

async function benchPlan(t: Target) {
  const started = Date.now();
  const res = await fetch(`${t.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: t.planModel,
      messages: [
        {
          role: "system",
          content:
            SYSTEM +
            '\n\nPlan the speech. JSON only: {"caseLine":"","rebuttals":[{"target":"","response":""}],' +
            '"arguments":[{"claim":"","mechanism":"","impact":""}],"weighing":""}',
        },
        { role: "user", content: DIGEST },
      ],
      max_completion_tokens: 5000,
      ...effortFor(t.planModel, "medium"),
      response_format: { type: "json_object" },
    }),
  });
  const ms = Date.now() - started;
  if (!res.ok) return { ok: false, ms, detail: `${res.status} ${(await res.text()).slice(0, 90)}` };
  const json = await res.json();
  const content = (json.choices?.[0]?.message?.content ?? "").trim();
  return { ok: Boolean(content), ms, detail: content ? `${content.length} chars` : "empty" };
}

async function benchSpeech(t: Target) {
  const started = Date.now();
  let ttft = 0;
  let text = "";

  const res = await fetch(`${t.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: t.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${DIGEST}\n\nNow deliver the speech.` },
      ],
      max_completion_tokens: 5000,
      ...effortFor(t.model, "low"),
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    return { ok: false, ms: Date.now() - started, ttft: 0, words: 0, wps: 0, detail: `${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") break outer;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) {
          if (!ttft) ttft = Date.now() - started;
          text += delta;
        }
      } catch {
        /* keep-alive */
      }
    }
  }

  const ms = Date.now() - started;
  const clean = strip(text);
  const w = words(clean);
  return { ok: w > 0, ms, ttft, words: w, wps: w / (ms / 1000), detail: clean.slice(0, 60) };
}

console.log(`Benchmarking ${targets.map((t) => t.label).join(", ")} · ${RUNS} run(s)`);
console.log(`Speech is delivered at ~${DELIVERY_WPS} words/sec — generation must beat that.\n`);

for (const t of targets) {
  console.log(`\x1b[1m${t.label}\x1b[0m  plan=${t.planModel}  speech=${t.model}`);
  for (let i = 0; i < RUNS; i++) {
    try {
      const plan = await benchPlan(t);
      console.log(
        `  plan    ${plan.ok ? "ok  " : "FAIL"} ${String(plan.ms).padStart(6)}ms  ${plan.detail}`,
      );
    } catch (err) {
      console.log(`  plan    FAIL  ${String(err).slice(0, 90)}`);
    }
    try {
      const sp = await benchSpeech(t);
      const verdict = !sp.ok
        ? "no output"
        : sp.wps >= DELIVERY_WPS
          ? `\x1b[32m${(sp.wps / DELIVERY_WPS).toFixed(1)}x realtime\x1b[0m`
          : `\x1b[31m${(sp.wps / DELIVERY_WPS).toFixed(2)}x — TOO SLOW\x1b[0m`;
      console.log(
        `  speech  ${sp.ok ? "ok  " : "FAIL"} ${String(sp.ms).padStart(6)}ms  ` +
          `ttft ${String(sp.ttft).padStart(5)}ms  ${String(sp.words).padStart(4)}w  ` +
          `${sp.wps.toFixed(2)} w/s  ${verdict}${sp.ok ? "" : "  " + sp.detail}`,
      );
    } catch (err) {
      console.log(`  speech  FAIL  ${String(err).slice(0, 90)}`);
    }
  }
  console.log();
}

export {};
