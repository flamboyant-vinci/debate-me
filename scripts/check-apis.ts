// Smoke-test every external dependency before we build on it.
//   node --env-file=.env.local scripts/check-apis.ts
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROQ = process.env.GROQ_API_KEY ?? "";
const RUMIK = process.env.RUMIK_API_KEY ?? "";

function ok(label: string, detail: string) {
  console.log(`\x1b[32m PASS \x1b[0m ${label} — ${detail}`);
}
function fail(label: string, detail: string) {
  console.log(`\x1b[31m FAIL \x1b[0m ${label} — ${detail}`);
  process.exitCode = 1;
}

async function checkBackupProviders() {
  const targets: Array<{ label: string; base: string; key: string; model: string }> = [];
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
    targets.push({
      label: "litellm",
      base: process.env.LITELLM_BASE_URL.replace(/\/$/, ""),
      key: process.env.LITELLM_API_KEY,
      model: process.env.LITELLM_MODEL ?? "cf/gpt-oss-120b",
    });
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    targets.push({
      label: "cloudflare",
      base:
        process.env.CLOUDFLARE_OPENAI_BASE?.replace(/\/$/, "") ??
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      key: process.env.CLOUDFLARE_API_TOKEN,
      model: process.env.CLOUDFLARE_MODEL ?? "@cf/openai/gpt-oss-120b",
    });
  }
  if (!targets.length) {
    console.log("\x1b[33m SKIP \x1b[0m backup provider — no LITELLM_* or CLOUDFLARE_* configured");
    return;
  }
  for (const t of targets) {
    const started = Date.now();
    try {
      const res = await fetch(`${t.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: t.model,
          messages: [{ role: "user", content: "Reply with exactly: POINT OF INFORMATION" }],
          max_completion_tokens: 2048,
        }),
      });
      if (!res.ok) {
        fail(`${t.label} chat`, `${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      const json = await res.json();
      const content = (json.choices?.[0]?.message?.content ?? "").trim();
      if (!content) {
        fail(`${t.label} chat`, `empty content (model ${t.model}) — check reasoning budget`);
        continue;
      }
      ok(`${t.label} chat`, `${Date.now() - started}ms · ${t.model} · "${content.slice(0, 60)}"`);
    } catch (err) {
      fail(`${t.label} chat`, String(err).slice(0, 200));
    }
  }
}

async function checkGroqChat() {
  const t = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.DEBSOC_MODEL ?? "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "Reply with exactly: POINT OF INFORMATION" }],
      // Generous: reasoning is billed against this, and a tight cap returns empty.
      max_completion_tokens: 2048,
      reasoning_effort: "low",
    }),
  });
  if (!res.ok) return fail("groq chat", `${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const content = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!content) return fail("groq chat", "empty content — reasoning consumed the token budget");
  ok("groq chat", `${Date.now() - t}ms · "${content}"`);
}

async function checkGroqModels() {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${GROQ}` },
  });
  if (!res.ok) return fail("groq models", `${res.status}`);
  const json = await res.json();
  const ids: string[] = json.data.map((m: { id: string }) => m.id).sort();
  ok("groq models", `${ids.length} available`);
  console.log("        " + ids.join("\n        "));
}

async function checkGroqWhisper(wavPath: string) {
  const { readFileSync } = await import("node:fs");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "speech.wav");
  form.append("model", "whisper-large-v3-turbo");
  const t = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ}` },
    body: form,
  });
  if (!res.ok) return fail("groq whisper", `${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  ok("groq whisper", `${Date.now() - t}ms · "${(json.text ?? "").trim()}"`);
}

async function checkRumik(): Promise<string | null> {
  const t = Date.now();
  const res = await fetch("https://silk-api.rumik.ai/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUMIK}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mulberry",
      speaker: "lucas",
      text: "Point of information. Madam Speaker, the opening government has not told this house who actually pays.",
      description: "male 20s voice, crisp British accent, confident debating cadence",
    }),
  });
  if (!res.ok) {
    fail("rumik tts", `${res.status} ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const path = "/tmp/rumik-test.wav";
  writeFileSync(path, buf);
  ok(
    "rumik tts",
    `${Date.now() - t}ms · ${buf.length} bytes · ${res.headers.get("x-audio-duration-ms")}ms audio · cost ${res.headers.get("x-usage-cost-nanos")} nanos · ${path}`,
  );
  return path;
}

async function checkRumikWs() {
  const res = await fetch("https://silk-api.rumik.ai/v1/tts/ws-connect", {
    method: "POST",
    headers: { Authorization: `Bearer ${RUMIK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mulberry", speaker: "emma" }),
  });
  if (!res.ok) return fail("rumik ws-connect", `${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  ok("rumik ws-connect", `ws_url=${json.ws_url ?? JSON.stringify(json).slice(0, 120)}`);
}

const main = async () => {
  if (!GROQ) fail("env", "GROQ_API_KEY missing");
  if (!RUMIK) fail("env", "RUMIK_API_KEY missing");
  await checkGroqModels();
  await checkGroqChat();
  const wav = await checkRumik();
  if (wav) {
    await checkGroqWhisper(wav);
    if (process.argv.includes("--play")) {
      spawnSync("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", wav], { stdio: "inherit" });
    }
  }
  await checkRumikWs();
  await checkBackupProviders();
};

main();
