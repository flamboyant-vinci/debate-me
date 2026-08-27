// Next.js custom server + Socket.IO. One process: `npm run dev`.
// Run with node's TypeScript stripping — no build step for the server.
import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import type { Position, RoundProfile, SkillTier } from "../src/shared/types.ts";
import { Round } from "./round/machine.ts";
import * as db from "./db/index.ts";
import * as diag from "./diagnostics.ts";
import * as trace from "./ai/trace.ts";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev });
const handle = app.getRequestHandler();

/** One active round per socket. Single-player, so this is deliberately simple. */
const rounds = new Map<string, Round>();

await app.prepare();

const httpServer = createServer((req, res) => {
  if (req.url === "/api/circuit") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ standings: db.standings(), history: db.history() }));
    return;
  }
  handle(req, res);
});

const io = new Server(httpServer, {
  // Speech audio arrives as base64 WAV; the default 1 MB cap is far too small.
  maxHttpBufferSize: 12e6,
  cors: { origin: true },
});

io.on("connection", (socket: Socket) => {
  const emit = {
    state: (s: unknown) => socket.emit("state", s),
    chat: (m: unknown) => socket.emit("chat", m),
    transcript: (p: unknown) => socket.emit("transcript", p),
    audio: (p: unknown) => socket.emit("audio", p),
    audioEnd: (p: unknown) => socket.emit("audioEnd", p),
    error: (p: { message: string }) => {
      console.error("[round]", p.message);
      socket.emit("error", p);
    },
  } as never;

  const current = () => rounds.get(socket.id);

  socket.on(
    "startRound",
    async (payload: {
      profileId: RoundProfile["id"];
      position?: Position | "random";
      fieldLevel?: SkillTier | "mixed";
      levels?: Partial<Record<Position, SkillTier>>;
    }) => {
      current()?.destroy();
      const round = new Round(emit, payload?.profileId ?? "full", payload?.position, {
        fieldLevel: payload?.fieldLevel,
        levels: payload?.levels,
      });
      rounds.set(socket.id, round);
      socket.emit("state", round.state);
      for (const m of round.chat) socket.emit("chat", m);
      try {
        await round.start();
      } catch (err) {
        console.error("[round] start failed", err);
        socket.emit("error", { message: String(err) });
      }
    },
  );

  socket.on("sendChat", (payload: { channelId: string; content: string }) => {
    void current()?.onChat(payload.channelId, payload.content);
  });

  socket.on("beginSpeech", () => current()?.beginSpeech());
  socket.on("endSpeech", () => current()?.endSpeech());
  socket.on("advance", () => void current()?.advance());

  socket.on("micChunk", (payload: { audio: string }) => {
    if (!payload?.audio) return;
    void current()?.onMicChunk(Buffer.from(payload.audio, "base64"));
  });

  socket.on("respondToPoi", (payload: { poiId: string; accept: boolean }) => {
    current()?.respondToPoi(payload.poiId, payload.accept);
  });

  socket.on("offerPoi", (payload: { text: string }) => {
    current()?.offerPoi(payload.text);
  });

  // --- #soundcheck: works with or without a round in progress ---------------

  socket.on("diag:report", (ack: (r: unknown) => void) => {
    ack?.({ report: diag.report(), voices: diag.voices(), sample: diag.SAMPLE_LINE });
  });

  socket.on("diag:traces", (ack: (r: unknown) => void) => {
    ack?.({
      recent: trace.recent(60),
      summary: trace.summary(),
      langfuse: trace.langfuseConfigured(),
    });
  });

  socket.on("diag:checks", async (ack: (r: unknown) => void) => {
    try {
      ack?.({ results: await diag.runChecks() });
    } catch (err) {
      ack?.({ results: [], error: String(err).slice(0, 200) });
    }
  });

  socket.on(
    "diag:speak",
    async (payload: { voiceId: string; text?: string }, ack: (r: unknown) => void) => {
      try {
        let seq = 0;
        const result = await diag.speakSample(payload.voiceId, payload.text ?? "", (chunk) => {
          socket.emit("audio", {
            personaId: payload.voiceId,
            seq: seq++,
            wav: chunk.wav.toString("base64"),
            text: chunk.text,
          });
        });
        socket.emit("audioEnd", { personaId: payload.voiceId });
        ack?.(result);
      } catch (err) {
        ack?.({ error: String(err).slice(0, 200) });
      }
    },
  );

  socket.on(
    "diag:transcribe",
    async (payload: { audio: string }, ack: (r: unknown) => void) => {
      try {
        ack?.(await diag.testMicrophone(Buffer.from(payload.audio, "base64")));
      } catch (err) {
        ack?.({ error: String(err).slice(0, 200) });
      }
    },
  );

  socket.on("endRound", () => {
    const round = current();
    if (!round) return;
    round.abandon();
    rounds.delete(socket.id);
    socket.emit("roundEnded");
  });

  socket.on("disconnect", () => {
    current()?.destroy();
    rounds.delete(socket.id);
  });
});

httpServer.listen(port, () => {
  console.log(`  debsoc ready on http://localhost:${port}`);
});
