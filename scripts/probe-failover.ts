// Proves the backup provider actually takes over. Runs with a deliberately
// broken Groq key, so every call must fall through to LiteLLM/Cloudflare.
//
//   node --env-file=.env.local scripts/probe-failover.ts
process.env.GROQ_API_KEY = "gsk_deliberately_invalid_key_for_failover_test";

const { chat, chatStream, providerStatus, probeProviders } = await import("../server/ai/llm.ts");

console.log("chain:", providerStatus().map((p) => `${p.id}(${p.primary})`).join(" → "));
if (providerStatus().length < 2) {
  console.error("\nNo backup configured — set LITELLM_* or CLOUDFLARE_* in .env.local");
  process.exit(1);
}

console.log("\nper-provider probe (groq is expected to FAIL here):");
for (const p of await probeProviders()) {
  console.log(`  ${p.ok ? "PASS" : "FAIL"} ${p.id} ${p.ms}ms — ${p.detail.slice(0, 120)}`);
}

console.log("\nnon-streaming call with groq broken:");
let t = Date.now();
const answer = await chat(
  [{ role: "user", content: "In one sentence, what must a Member of Government do in BP?" }],
  { maxTokens: 300 },
);
console.log(`  ${Date.now() - t}ms · ${answer.split(/\s+/).filter(Boolean).length} words`);
console.log(`  "${answer.slice(0, 200)}"`);

console.log("\nstreaming call with groq broken:");
t = Date.now();
let text = "";
let deltas = 0;
for await (const d of chatStream(
  [{ role: "user", content: "Deliver two sentences of a Prime Minister speech on banning cars." }],
  { maxTokens: 300 },
)) {
  text += d;
  deltas += 1;
}
console.log(`  ${Date.now() - t}ms · ${deltas} deltas · ${text.split(/\s+/).filter(Boolean).length} words`);
console.log(`  "${text.slice(0, 200)}"`);

console.log(
  text && answer
    ? "\nFAILOVER OK — the round would have continued through a Groq outage."
    : "\nFAILOVER BROKEN — empty output from the backup.",
);
process.exit(text && answer ? 0 : 1);

export {};
