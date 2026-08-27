// Headless round runner. Drives the server exactly as the browser would, so the
// whole machine — draw, prep chat, eight speeches, POIs, deliberation, results —
// can be exercised without a microphone.
//
//   node scripts/dry-round.ts [fast|full]
import { io } from "socket.io-client";
import type { ChatMessage, RoundState } from "../src/shared/types.ts";
import { SPEAKING_ORDER } from "../src/shared/bp.ts";

const profileId = (process.argv[2] as "fast" | "full") ?? "fast";
const socket = io("http://localhost:3000", { transports: ["websocket"], reconnection: false });

let lastPhase = "";
let audioChunks = 0;
let audioBytes = 0;
let floorTaken = false;
let poiOffered = false;
const t0 = Date.now();

const stamp = () => `${String(Math.floor((Date.now() - t0) / 1000)).padStart(4)}s`;

socket.on("connect", () => {
  console.log(`${stamp()} connected — starting a ${profileId} round`);
  socket.emit("startRound", { profileId, position: "LO" });
});

socket.on("chat", (m: ChatMessage) => {
  const who = m.system ? "·" : m.authorName;
  console.log(`${stamp()} [${m.channelId}] ${who}: ${m.content.replace(/\n/g, " ").slice(0, 160)}`);
});

socket.on("error", (p: { message: string }) => console.error(`${stamp()} ERROR ${p.message}`));

socket.on("audio", (p: { wav: string }) => {
  audioChunks += 1;
  audioBytes += p.wav.length * 0.75;
});

socket.on("transcript", (p: { position: string; text: string; final: boolean }) => {
  if (p.final) {
    console.log(`${stamp()} TRANSCRIPT ${p.position} final — ${p.text.split(/\s+/).length} words`);
  }
});

socket.on("state", (s: RoundState) => {
  if (s.phase !== lastPhase) {
    console.log(`${stamp()} PHASE ${lastPhase || "—"} → ${s.phase}`);
    lastPhase = s.phase;

    if (s.phase === "PREP") {
      // Say something so the partner has to engage, then start early.
      setTimeout(() => socket.emit("sendChat", {
        channelId: "team-prep",
        content: "I'll take the definitional challenge and the first two rebuttals. What's your extension?",
      }), 3000);
      setTimeout(() => socket.emit("advance"), 25_000);
    }

    if (s.phase === "RESULTS") {
      const r = s.result;
      console.log("\n=========== RESULT ===========");
      console.log("ranking:", r?.ranking.join(" > "));
      console.log("speaks:", SPEAKING_ORDER.map((p) => `${p}=${r?.speaks[p]}`).join(" "));
      console.log("calls:", r?.calls.map((c) => `${c.judgeName}: ${c.ranking.join(">")}`).join(" | "));
      console.log("your elo delta:", r?.humanEloDelta);
      console.log("oral length:", r?.oral.split(/\s+/).length, "words");
      console.log(`audio: ${audioChunks} chunks, ${(audioBytes / 1e6).toFixed(1)} MB`);
      console.log(`tts chars billed: ${s.ttsChars}`);
      console.log("==============================\n");
      setTimeout(() => process.exit(0), 3000);
    }
  }

  // It is our turn: take the floor, say nothing, sit down.
  const position = SPEAKING_ORDER[s.speechIndex];
  if (s.phase === "ROUND" && position === s.humanPosition && !floorTaken) {
    floorTaken = true;
    console.log(`${stamp()} taking the floor as ${position}`);
    setTimeout(() => socket.emit("beginSpeech"), 1500);
    setTimeout(() => {
      console.log(`${stamp()} sitting down`);
      socket.emit("endSpeech");
    }, 30_000);
  }

  // Rise on a point during the first AI speech that is past protected time.
  if (s.phase === "ROUND" && !poiOffered && s.clock.startedAt && position !== s.humanPosition) {
    const elapsed = Date.now() - s.clock.startedAt;
    if (elapsed > 25_000) {
      poiOffered = true;
      console.log(`${stamp()} offering a POI`);
      socket.emit("offerPoi", { text: "Who actually enforces this, and with what budget?" });
    }
  }
});

setTimeout(() => {
  console.error("dry round timed out");
  process.exit(1);
}, 45 * 60_000);
