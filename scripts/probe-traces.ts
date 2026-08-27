// Makes a couple of real calls, then reads back what the trace layer recorded.
//   node --env-file=.env.local scripts/probe-traces.ts
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", { transports: ["websocket"], reconnection: false });
const ask = <T,>(event: string, payload?: unknown): Promise<T> =>
  new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });

interface Trace {
  op: string;
  provider: string;
  model: string;
  latencyMs: number;
  status: string;
  promptChars: number;
  completionChars: number;
  fellBackFrom: string[];
  error?: string;
}

socket.on("connect", async () => {
  // diag:checks probes every provider, which is enough to populate traces.
  const checks = await ask<{ results: Array<{ label: string; ok: boolean }> }>("diag:checks");
  console.log("checks:", (checks.results ?? []).map((r) => `${r.label}=${r.ok ? "ok" : "FAIL"}`).join(" "));

  const t = await ask<{
    recent: Trace[];
    summary: {
      total: number;
      failovers: number;
      byProvider: Array<{ key: string; calls: number; errors: number; empty: number; avgMs: number }>;
      byOp: Array<{ key: string; calls: number; avgMs: number }>;
    };
    langfuse: boolean;
  }>("diag:traces");

  console.log(`\ntotal=${t.summary.total} failovers=${t.summary.failovers} langfuse=${t.langfuse}`);
  console.log("by provider:");
  for (const r of t.summary.byProvider) {
    console.log(`  ${r.key.padEnd(14)} ${r.calls} calls  ${r.avgMs}ms avg  ${r.errors} err  ${r.empty} empty`);
  }
  console.log("recent calls:");
  for (const e of t.recent.slice(0, 8)) {
    console.log(
      `  ${e.status.padEnd(5)} ${e.op.padEnd(16)} ${e.provider.padEnd(12)} ${String(e.model).padEnd(24)} ` +
        `${String(e.latencyMs).padStart(6)}ms  ${e.promptChars}→${e.completionChars}` +
        (e.fellBackFrom.length ? `  after ${e.fellBackFrom.join(",")}` : "") +
        (e.error ? `  ${e.error.slice(0, 60)}` : ""),
    );
  }
  process.exit(t.summary.total > 0 ? 0 : 1);
});

setTimeout(() => {
  console.error("trace probe timed out");
  process.exit(1);
}, 180_000);

export {};
