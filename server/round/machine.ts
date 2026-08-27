// The round engine. Server-authoritative: it owns the clock, decides when POIs
// may be offered, drives speech generation and synthesis, paces audio delivery to
// the browser, and runs the adjudication at the end.
import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  JudgeCall,
  Persona,
  SkillTier,
  PoiRecord,
  Position,
  RoundProfile,
  RoundState,
  Seat,
  SpeechRecord,
  TeamId,
} from "../../src/shared/types.ts";
import {
  PARTNER_OF,
  POSITION_NAMES,
  PROFILES,
  SPEAKING_ORDER,
  TEAM_NAMES,
  TEAM_OF,
  poiWindow,
} from "../../src/shared/bp.ts";
import { DEBATERS, HUMAN_COLOR, JUDGES, PERSONA_BY_ID } from "../data/personas.ts";
import { pickMotion } from "../data/motions.ts";
import * as db from "../db/index.ts";
import { speakStream, speakText, usage } from "../tts/rumik.ts";
import type { Mood, SpokenChunk } from "../tts/rumik.ts";
import {
  benchWhisper,
  extractArguments,
  planSpeech,
  streamSpeech,
} from "../ai/speech.ts";
import * as partnerAi from "../ai/partner.ts";
import * as poiAi from "../ai/poi.ts";
import * as judgeAi from "../ai/judge.ts";
import { maxPanelSize, transcribe } from "../ai/llm.ts";
import { withOp } from "../ai/trace.ts";

export const CHANNELS = {
  announcements: "announcements",
  motion: "motion-release",
  prep: "team-prep",
  deliberation: "judges-deliberation",
  feedback: "feedback",
} as const;

export interface Emitter {
  state: (state: RoundState) => void;
  chat: (message: ChatMessage) => void;
  transcript: (payload: { position: Position; text: string; final: boolean }) => void;
  audio: (payload: { personaId: string; seq: number; wav: string; text: string }) => void;
  audioEnd: (payload: { personaId: string }) => void;
  error: (payload: { message: string }) => void;
}

/** How far ahead of real-time playback we are willing to push audio. */
const AUDIO_LEAD_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T>(xs: T[]): T[] => xs.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

export class Round {
  state: RoundState;
  chat: ChatMessage[] = [];
  private emit: Emitter;
  private abort = new AbortController();

  /** Set while the human is speaking; mic chunks append here. */
  private liveTranscript = "";
  private humanSpeechResolve: (() => void) | null = null;
  private prepNotes = partnerAi.emptyNotes();
  private lastHumanPrepMessageAt = 0;
  private prepTimers: NodeJS.Timeout[] = [];
  private poiTimers: NodeJS.Timeout[] = [];

  /** POI raised by the human against the AI currently speaking. */
  private pendingHumanPoi: PoiRecord | null = null;
  /** Resolves the human's accept/decline of an AI POI. */
  private humanPoiDecision = new Map<string, (accept: boolean) => void>();

  constructor(
    emit: Emitter,
    profileId: RoundProfile["id"],
    preferred?: Position | "random",
    opts: { fieldLevel?: SkillTier | "mixed"; levels?: Partial<Record<Position, SkillTier>> } = {},
  ) {
    this.emit = emit;
    this.state = this.draw(profileId, preferred, opts);
  }

  // ---------------------------------------------------------------- draw

  private draw(
    profileId: RoundProfile["id"],
    preferred?: Position | "random",
    opts: { fieldLevel?: SkillTier | "mixed"; levels?: Partial<Record<Position, SkillTier>> } = {},
  ): RoundState {
    const profile = PROFILES[profileId] ?? PROFILES.full;
    const humanPosition: Position =
      !preferred || preferred === "random"
        ? SPEAKING_ORDER[Math.floor(Math.random() * SPEAKING_ORDER.length)]
        : preferred;

    // Fill the table. A seat can be pinned to a skill level, or left to the draw —
    // the tier spread is what makes the room feel like a real one.
    const pool = shuffle([...DEBATERS]);
    const taken = new Set<string>();
    const pick = (wanted?: SkillTier): Persona => {
      const match = wanted && pool.find((p) => p.tier === wanted && !taken.has(p.id));
      // Reuse a persona of the right tier rather than silently ignore the request.
      const chosen =
        match ??
        pool.find((p) => !taken.has(p.id)) ??
        (wanted ? DEBATERS.filter((p) => p.tier === wanted)[0] : undefined) ??
        DEBATERS[0];
      taken.add(chosen.id);
      return chosen;
    };

    const seats: Seat[] = [];
    for (const position of SPEAKING_ORDER) {
      if (position === humanPosition) {
        seats.push({ position, team: TEAM_OF[position], personaId: "human", displayName: "You" });
        continue;
      }
      const wanted =
        opts.levels?.[position] ??
        (opts.fieldLevel && opts.fieldLevel !== "mixed" ? opts.fieldLevel : undefined);
      const persona = pick(wanted);
      seats.push({
        position,
        team: TEAM_OF[position],
        personaId: persona.id,
        displayName: persona.name,
      });
    }

    // A three-judge panel is the more interesting experience, but each judge reads
    // the whole round, so the cap tracks how much token budget is actually available.
    const panelSize = maxPanelSize() >= 3 && Math.random() < 0.55 ? 3 : 1;
    const judges = [JUDGES[0], ...shuffle(JUDGES.slice(1))].slice(0, panelSize);

    return {
      id: randomUUID(),
      phase: "LOBBY",
      profile,
      motion: null,
      seats,
      humanPosition,
      speechIndex: 0,
      clock: { startedAt: null, lengthMs: profile.speechMs, graceMs: profile.graceMs, paused: false, pausedElapsedMs: 0 },
      prepEndsAt: null,
      speeches: [],
      standingPois: [],
      judges,
      result: null,
      ttsChars: 0,
      speakingPersonaId: null,
    };
  }

  // ------------------------------------------------------------- helpers

  private seatOf(position: Position): Seat {
    return this.state.seats.find((s) => s.position === position)!;
  }

  private personaOf(position: Position): Persona | null {
    const seat = this.seatOf(position);
    return seat.personaId === "human" ? null : PERSONA_BY_ID[seat.personaId] ?? null;
  }

  private push(): void {
    this.state.ttsChars = usage.chars;
    this.emit.state(this.state);
  }

  say(channelId: string, authorId: string, authorName: string, color: string, content: string, system = false): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      channelId,
      authorId,
      authorName,
      authorColor: color,
      content,
      ts: Date.now(),
      system,
    };
    this.chat.push(msg);
    this.emit.chat(msg);
    return msg;
  }

  private system(channelId: string, content: string): void {
    this.say(channelId, "system", "Tab", "#8e9297", content, true);
  }

  destroy(): void {
    this.abort.abort();
    for (const t of [...this.prepTimers, ...this.poiTimers]) clearTimeout(t);
    // Release anything waiting on the human so no promise is left dangling.
    this.humanSpeechResolve?.();
    for (const resolve of this.humanPoiDecision.values()) resolve(false);
    this.humanPoiDecision.clear();
  }

  /** Walk out of the round: everything stops, nothing is recorded. */
  abandon(): void {
    this.system(CHANNELS.announcements, "You left the round. Nothing was recorded.");
    this.destroy();
  }

  // --------------------------------------------------------------- flow

  async start(): Promise<void> {
    this.state.phase = "DRAW";
    this.push();

    const human = this.seatOf(this.state.humanPosition!);
    this.system(
      CHANNELS.announcements,
      `Round drawn. You are **${POSITION_NAMES[human.position]}** for **${TEAM_NAMES[human.team]}**.`,
    );
    for (const team of ["OG", "OO", "CG", "CO"] as TeamId[]) {
      const members = this.state.seats.filter((s) => s.team === team);
      this.system(
        CHANNELS.announcements,
        `${TEAM_NAMES[team]} — ${members.map((m) => `${m.displayName} (${m.position})`).join(", ")}`,
      );
    }
    this.system(
      CHANNELS.announcements,
      `Adjudication: ${this.state.judges.map((j, i) => `${j.name}${i === 0 ? " (chair)" : ""}`).join(", ")}`,
    );

    await sleep(1500);
    await this.releaseMotion();
  }

  private async releaseMotion(): Promise<void> {
    this.state.motion = pickMotion(undefined, db.recentMotionIds());
    this.state.phase = "MOTION";
    this.push();

    this.system(CHANNELS.motion, `**Motion:** ${this.state.motion.text}`);
    if (this.state.motion.infoslide) {
      this.system(CHANNELS.motion, `**Info slide:** ${this.state.motion.infoslide}`);
    }
    this.system(
      CHANNELS.motion,
      `Prep time: ${Math.round(this.state.profile.prepMs / 60000)} minutes. Talk to your partner in #team-prep.`,
    );

    await this.beginPrep();
  }

  private async beginPrep(): Promise<void> {
    this.state.phase = "PREP";
    this.state.prepEndsAt = Date.now() + this.state.profile.prepMs;
    this.push();

    const humanSeat = this.seatOf(this.state.humanPosition!);
    const partnerSeat = this.seatOf(PARTNER_OF[humanSeat.position]);
    const partnerPersona = PERSONA_BY_ID[partnerSeat.personaId];

    // Prep ends on the clock whether or not anyone is ready.
    this.prepTimers.push(
      setTimeout(() => {
        void this.runRound().catch((e) => this.emit.error({ message: String(e) }));
      }, this.state.profile.prepMs),
    );
    // Warnings, as a chair would give them.
    for (const at of [0.5, 0.8, 0.95]) {
      this.prepTimers.push(
        setTimeout(() => {
          const left = Math.round((this.state.profile.prepMs * (1 - at)) / 60000);
          this.system(CHANNELS.prep, left >= 1 ? `${left} minute${left > 1 ? "s" : ""} of prep remaining.` : "Thirty seconds. Wrap up.");
        }, this.state.profile.prepMs * at),
      );
    }

    if (!partnerPersona) return;

    try {
      const opener = await partnerAi.openPrep(this.state, { seat: partnerSeat, persona: partnerPersona }, humanSeat);
      this.say(CHANNELS.prep, partnerPersona.id, partnerPersona.name, partnerPersona.avatarColor, opener);
    } catch (e) {
      this.emit.error({ message: `Partner chat failed: ${String(e)}` });
    }

    // If you go quiet, your partner keeps thinking out loud.
    const nudgeEvery = Math.max(60_000, this.state.profile.prepMs / 6);
    const scheduleNudge = () => {
      this.prepTimers.push(
        setTimeout(async () => {
          if (this.state.phase !== "PREP") return;
          if (Date.now() - this.lastHumanPrepMessageAt < nudgeEvery) return scheduleNudge();
          const left = Math.max(1, Math.round(((this.state.prepEndsAt ?? 0) - Date.now()) / 60000));
          try {
            const line = await partnerAi.prepNudge(
              this.state,
              { seat: partnerSeat, persona: partnerPersona },
              humanSeat,
              this.chat.filter((m) => m.channelId === CHANNELS.prep && !m.system),
              left,
            );
            this.say(CHANNELS.prep, partnerPersona.id, partnerPersona.name, partnerPersona.avatarColor, line);
          } catch {
            /* a quiet partner is survivable */
          }
          scheduleNudge();
        }, nudgeEvery),
      );
    };
    scheduleNudge();
  }

  /** A message the human typed in a channel. */
  async onChat(channelId: string, content: string): Promise<void> {
    this.say(channelId, "human", "You", HUMAN_COLOR, content);
    if (channelId !== CHANNELS.prep || this.state.phase !== "PREP") return;

    this.lastHumanPrepMessageAt = Date.now();
    const humanSeat = this.seatOf(this.state.humanPosition!);
    const partnerSeat = this.seatOf(PARTNER_OF[humanSeat.position]);
    const partnerPersona = PERSONA_BY_ID[partnerSeat.personaId];
    if (!partnerPersona) return;

    const left = Math.max(0, Math.round(((this.state.prepEndsAt ?? 0) - Date.now()) / 60000));
    try {
      const reply = await partnerAi.replyInPrep(
        this.state,
        { seat: partnerSeat, persona: partnerPersona },
        humanSeat,
        this.chat.filter((m) => m.channelId === CHANNELS.prep && !m.system),
        left,
      );
      this.say(CHANNELS.prep, partnerPersona.id, partnerPersona.name, partnerPersona.avatarColor, reply);
    } catch (e) {
      this.emit.error({ message: `Partner reply failed: ${String(e)}` });
    }
  }

  /** Skip the rest of prep and start the round. */
  async advance(): Promise<void> {
    if (this.state.phase === "PREP") {
      for (const t of this.prepTimers) clearTimeout(t);
      this.prepTimers = [];
      await this.runRound();
    }
  }

  // -------------------------------------------------------------- round

  private async runRound(): Promise<void> {
    if (this.state.phase === "ROUND") return;
    this.state.phase = "ROUND";
    this.state.prepEndsAt = null;
    this.push();

    const humanSeat = this.seatOf(this.state.humanPosition!);
    const partnerSeat = this.seatOf(PARTNER_OF[humanSeat.position]);
    const partnerPersona = PERSONA_BY_ID[partnerSeat.personaId];
    if (partnerPersona) {
      this.prepNotes = await partnerAi.summariseNotes(
        this.state,
        { seat: partnerSeat, persona: partnerPersona },
        humanSeat,
        this.chat.filter((m) => m.channelId === CHANNELS.prep && !m.system),
      );
    }

    this.system(CHANNELS.announcements, "Prep is over. Debate Room 1 is live.");

    for (let i = 0; i < SPEAKING_ORDER.length; i++) {
      if (this.abort.signal.aborted) return;
      this.state.speechIndex = i;
      const position = SPEAKING_ORDER[i];
      const seat = this.seatOf(position);

      this.system(
        CHANNELS.announcements,
        `**${POSITION_NAMES[position]}** — ${seat.displayName} (${TEAM_NAMES[seat.team]}) has the floor.`,
      );
      this.push();

      if (seat.personaId === "human") {
        await this.runHumanSpeech(position);
      } else {
        await this.runAiSpeech(position);
      }

      // Work out what was just said while the next speaker walks up.
      const record = this.state.speeches[this.state.speeches.length - 1];
      if (record && !record.arguments.length) {
        record.arguments = await extractArguments(record);
      }
      this.push();
      await sleep(1200);
    }

    await this.adjudicate();
  }

  // ------------------------------------------------------- human speech

  /** Called when you click "Take the floor". */
  beginSpeech(): void {
    if (this.state.phase !== "ROUND") return;
    if (this.state.clock.startedAt) return;
    this.state.clock.startedAt = Date.now();
    this.liveTranscript = "";
    this.push();
    this.scheduleAiPois();
  }

  endSpeech(): void {
    this.humanSpeechResolve?.();
  }

  private async runHumanSpeech(position: Position): Promise<void> {
    this.state.clock.startedAt = null;
    this.state.speakingPersonaId = "human";
    this.push();
    this.system(CHANNELS.announcements, "You have the floor. Click **Take the floor** when you are ready.");

    await new Promise<void>((resolve) => {
      this.humanSpeechResolve = () => {
        this.humanSpeechResolve = null;
        resolve();
      };
      // Hard cut at time plus grace, once started.
      const watch = setInterval(() => {
        const started = this.state.clock.startedAt;
        if (!started) return;
        const elapsed = Date.now() - started;
        if (elapsed >= this.state.profile.speechMs + this.state.profile.graceMs) {
          clearInterval(watch);
          this.system(CHANNELS.announcements, "Time. The chair cuts you off.");
          this.humanSpeechResolve?.();
        }
      }, 500);
      this.abort.signal.addEventListener("abort", () => {
        clearInterval(watch);
        resolve();
      });
    });

    for (const t of this.poiTimers) clearTimeout(t);
    this.poiTimers = [];

    const started = this.state.clock.startedAt ?? Date.now();
    const record: SpeechRecord = {
      position,
      team: TEAM_OF[position],
      speakerName: "You",
      personaId: "human",
      transcript: this.liveTranscript.trim(),
      arguments: [],
      startedAt: started,
      durationMs: Date.now() - started,
      pois: this.state.standingPois.filter((p) => p.status !== "offered"),
    };
    this.state.speeches.push(record);
    this.state.standingPois = [];
    this.state.clock.startedAt = null;
    this.state.speakingPersonaId = null;
    this.emit.transcript({ position, text: record.transcript, final: true });
    this.push();
  }

  /** A segment of your microphone audio. */
  async onMicChunk(audio: Buffer): Promise<void> {
    if (!this.state.clock.startedAt) return;
    try {
      const text = await transcribe(audio, "segment.webm", this.liveTranscript);
      if (!text) return;
      this.liveTranscript = `${this.liveTranscript} ${text}`.trim();
      this.emit.transcript({
        position: this.state.humanPosition!,
        text: this.liveTranscript,
        final: false,
      });

      // Occasionally your partner slides you a note.
      if (Math.random() < 0.15) {
        const partnerSeat = this.seatOf(PARTNER_OF[this.state.humanPosition!]);
        const persona = PERSONA_BY_ID[partnerSeat.personaId];
        if (persona) {
          const line = await benchWhisper(this.state, persona, this.liveTranscript).catch(() => "");
          if (line) this.say(CHANNELS.prep, persona.id, persona.name, persona.avatarColor, line);
        }
      }
    } catch (e) {
      this.emit.error({ message: `Transcription failed: ${String(e)}` });
    }
  }

  /** Line up AI opponents to stand up during your speech. */
  private scheduleAiPois(): void {
    const position = this.state.humanPosition!;
    const [open, close] = poiWindow(this.state.profile);
    const offerers = poiAi
      .eligibleOfferers(this.state, position)
      .map((seat) => ({ seat, persona: PERSONA_BY_ID[seat.personaId] }))
      .filter((o): o is { seat: Seat; persona: Persona } => Boolean(o.persona));

    let offered = 0;
    // Try roughly every 45 seconds of the open window.
    for (let at = open + 15_000; at < close; at += 45_000) {
      const jitter = at + Math.random() * 20_000;
      this.poiTimers.push(
        setTimeout(async () => {
          if (!this.state.clock.startedAt || this.state.phase !== "ROUND") return;
          if (this.state.standingPois.some((p) => p.status === "offered")) return;
          const offerer = offerers[Math.floor(Math.random() * offerers.length)];
          if (!offerer || !poiAi.wantsToOffer(offerer.persona, offered)) return;
          offered += 1;
          await this.offerAiPoi(offerer, position);
        }, jitter),
      );
    }
  }

  private async offerAiPoi(offerer: { seat: Seat; persona: Persona }, target: Position): Promise<void> {
    let text: string;
    try {
      text = await poiAi.composePoi(this.state, offerer, target, this.liveTranscript);
    } catch {
      return;
    }
    const elapsed = Date.now() - (this.state.clock.startedAt ?? Date.now());
    const poi = poiAi.makePoi(offerer.persona.id, offerer.persona.name, text, elapsed);
    this.state.standingPois.push(poi);
    this.push();

    const accepted = await new Promise<boolean>((resolve) => {
      this.humanPoiDecision.set(poi.id, resolve);
      setTimeout(() => {
        if (this.humanPoiDecision.delete(poi.id)) resolve(false);
      }, 15_000);
    });

    poi.status = accepted ? "accepted" : "declined";
    this.push();

    if (accepted) {
      this.system(
        CHANNELS.announcements,
        `${offerer.persona.name}: “${text}”`,
      );
      await this.playAudio(offerer.persona.id, text, offerer.persona.voice, 0, {
        emotion: "energetic",
        intensity: "high",
        pacing: "fast",
      });
    }
  }

  /** Your accept/decline of a standing POI. */
  respondToPoi(poiId: string, accept: boolean): void {
    const resolve = this.humanPoiDecision.get(poiId);
    if (resolve) {
      this.humanPoiDecision.delete(poiId);
      resolve(accept);
    }
  }

  /** You raise a POI during an AI speech. */
  offerPoi(text: string): void {
    if (this.state.phase !== "ROUND" || !text.trim()) return;
    const speaking = SPEAKING_ORDER[this.state.speechIndex];
    if (this.seatOf(speaking).personaId === "human") return;
    const elapsed = Date.now() - (this.state.clock.startedAt ?? Date.now());
    const [open, close] = poiWindow(this.state.profile);
    if (elapsed < open || elapsed > close) {
      this.system(CHANNELS.announcements, "That is protected time — you cannot offer a point yet.");
      return;
    }
    if (this.pendingHumanPoi) return;
    this.pendingHumanPoi = poiAi.makePoi("human", "You", text.trim(), elapsed);
    this.state.standingPois.push(this.pendingHumanPoi);
    this.push();
  }

  // ---------------------------------------------------------- ai speech

  private async runAiSpeech(position: Position): Promise<void> {
    const seat = this.seatOf(position);
    const persona = this.personaOf(position);
    if (!persona) return;

    this.state.speakingPersonaId = persona.id;
    this.state.clock.startedAt = null;
    this.push();

    let plan;
    try {
      plan = await planSpeech(this.state, seat, persona, this.abort.signal);
    } catch (e) {
      this.emit.error({ message: `${persona.name} could not prepare: ${String(e)}` });
      plan = {
        caseLine: "",
        burden: "",
        rebuttals: [],
        turns: [],
        arguments: [],
        evenIf: [],
        counterModel: "",
        weighing: "",
      };
    }

    // Your partner honours what you agreed in prep.
    const notes =
      seat.position === PARTNER_OF[this.state.humanPosition!]
        ? partnerAi.notesForSpeech(this.prepNotes)
        : "";
    if (notes) plan.caseLine = `${plan.caseLine}\n${notes}`;

    const startedAt = Date.now();
    this.state.clock.startedAt = startedAt;
    this.push();

    let sentAudioMs = 0;
    let acceptedPois = 0;
    const pois: PoiRecord[] = [];
    let spoken = "";

    // The speech clock must follow the voice, not the generator. Generation can
    // stall for many seconds waiting on a rate-limit window, and if the clock
    // starts then, the timer — and the next speaker — run ahead of the audio the
    // listener is actually hearing. Everything below is measured from the moment
    // the first chunk is sent to the browser.
    let audioStartedAt: number | null = null;
    const clockBase = () => audioStartedAt ?? startedAt;

    // Models overrun their word target, so the clock is enforced the way a chair
    // enforces it: at time plus grace the speaker is cut off mid-sentence.
    const speechAbort = new AbortController();
    // Ending the round must stop a speech that is already streaming.
    this.abort.signal.addEventListener("abort", () => speechAbort.abort(), { once: true });
    const hardCutMs = this.state.profile.speechMs + this.state.profile.graceMs;
    let cutOff = false;
    const cutIfOverTime = () => {
      if (cutOff) return true;
      // Judge by audio already committed, not wall clock, or pacing lag hides the overrun.
      if (sentAudioMs >= hardCutMs) {
        cutOff = true;
        speechAbort.abort();
        this.system(CHANNELS.announcements, `Time. The chair cuts ${persona.name} off.`);
        return true;
      }
      return false;
    };

    const onChunk = async (chunk: SpokenChunk) => {
      if (cutIfOverTime()) return;
      // Pace delivery so the browser plays roughly in real time and the clock means something.
      while (sentAudioMs - (Date.now() - clockBase()) > AUDIO_LEAD_MS) {
        if (this.abort.signal.aborted || speechAbort.signal.aborted) return;
        await sleep(250);
      }

      // Handle a POI you raised, at a sentence boundary.
      if (this.pendingHumanPoi && this.pendingHumanPoi.status === "offered") {
        const poi = this.pendingHumanPoi;
        const elapsed = Date.now() - clockBase();
        const accept = poiAi.decideAcceptance(persona, acceptedPois, elapsed, this.state.profile.speechMs);
        poi.status = accept ? "accepted" : "declined";
        pois.push(poi);
        this.pendingHumanPoi = null;
        this.state.standingPois = this.state.standingPois.filter((p) => p.id !== poi.id);
        this.push();

        if (accept) {
          acceptedPois += 1;
          this.system(CHANNELS.announcements, `${persona.name} accepts your point.`);
          const answer = await poiAi
            .answerPoi(this.state, { seat, persona }, poi, spoken)
            .catch(() => "That is a fair point, but it does not change our case.");
          poi.answer = answer;
          sentAudioMs += await this.playAudio(persona.id, answer, persona.voice, sentAudioMs, {
            emotion: "energetic",
            intensity: "high",
          });
        } else {
          const line = poiAi.declineLine(persona);
          this.system(CHANNELS.announcements, `${persona.name} waves you down: “${line}”`);
          sentAudioMs += await this.playAudio(persona.id, line, persona.voice, sentAudioMs, {
            emotion: "dry",
            intensity: "low",
            pacing: "brisk",
          });
        }
      }

      if (audioStartedAt === null) {
        audioStartedAt = Date.now();
        this.state.clock.startedAt = audioStartedAt;
        this.push();
      }
      spoken += ` ${chunk.text}`;
      sentAudioMs += chunk.durationMs;
      this.emit.audio({
        personaId: persona.id,
        seq: chunk.seq,
        wav: chunk.wav.toString("base64"),
        text: chunk.text,
      });
      this.emit.transcript({ position, text: spoken.trim(), final: false });
    };

    let full = "";
    console.log(
      `[speech] ${persona.name} ${position} plan args=${plan.arguments.length} ` +
        `rebuttals=${plan.rebuttals.length} caseLine=${plan.caseLine.length}ch`,
    );
    try {
      full = await withOp("speech.prose", { personaId: persona.id, position }, () =>
        speakStream(
          streamSpeech(this.state, seat, persona, plan, speechAbort.signal),
          persona.voice,
          onChunk,
          { concurrency: 2, signal: speechAbort.signal },
        ),
      );
    } catch (e) {
      // Being cut off is a normal outcome, not a failure.
      if (!cutOff) this.emit.error({ message: `${persona.name}'s speech failed: ${String(e)}` });
      full = spoken;
    }
    if (cutOff) full = spoken;

    // A speaker must never silently sit down. An empty speech means every provider
    // refused, or the whole completion was reasoning that got stripped — either way
    // it is worth one more attempt before the round moves on with dead air.
    if (!full.trim() && !cutOff && !this.abort.signal.aborted) {
      this.emit.error({ message: `${persona.name} produced no speech — retrying.` });
      console.warn(`[speech] ${persona.name} ${position} came back empty; retrying once`);
      try {
        full = await withOp("speech.prose.retry", { personaId: persona.id, position }, () =>
          speakStream(
            streamSpeech(this.state, seat, persona, plan, speechAbort.signal),
            persona.voice,
            onChunk,
            { concurrency: 2, signal: speechAbort.signal },
          ),
        );
      } catch (e) {
        this.emit.error({ message: `${persona.name} could not speak at all: ${String(e)}` });
      }
      if (!full.trim()) {
        // Still nothing. Say so out loud rather than leaving unexplained silence.
        this.system(
          CHANNELS.announcements,
          `${persona.name} was unable to deliver a speech — the models are rate limited. ` +
            `The round continues.`,
        );
      }
    }
    console.log(
      `[speech] ${persona.name} ${position} delivered words=${full.split(/\s+/).filter(Boolean).length} ` +
        `audio=${Math.round(sentAudioMs / 1000)}s cutOff=${cutOff}`,
    );

    this.emit.audioEnd({ personaId: persona.id });

    // Let the tail of the audio actually play out before the next speaker starts.
    const remaining = sentAudioMs - (Date.now() - clockBase());
    if (remaining > 0) await sleep(Math.min(remaining, this.state.profile.speechMs));

    const record: SpeechRecord = {
      position,
      team: seat.team,
      speakerName: persona.name,
      personaId: persona.id,
      transcript: full.trim(),
      arguments: plan.arguments,
      startedAt,
      durationMs: Date.now() - startedAt,
      pois,
    };
    this.state.speeches.push(record);
    this.state.clock.startedAt = null;
    this.state.speakingPersonaId = null;
    this.state.standingPois = [];
    this.pendingHumanPoi = null;
    this.emit.transcript({ position, text: record.transcript, final: true });
    this.push();
  }

  /** Synthesise and ship a short passage. Returns its audio duration. */
  private async playAudio(
    personaId: string,
    text: string,
    voice: Persona["voice"],
    seqBase = 0,
    mood: Mood = {},
  ): Promise<number> {
    let total = 0;
    let n = 0;
    await speakText(
      text,
      voice,
      (chunk) => {
        total += chunk.durationMs;
        this.emit.audio({
          personaId,
          seq: seqBase + 10_000 + n++,
          wav: chunk.wav.toString("base64"),
          text: chunk.text,
        });
      },
      { signal: this.abort.signal, mood },
    ).catch(() => undefined);
    return total;
  }

  // --------------------------------------------------------- adjudication

  private async adjudicate(): Promise<void> {
    this.state.phase = "DELIBERATION";
    this.push();
    this.system(CHANNELS.announcements, "The panel has retired to deliberate.");

    const calls: JudgeCall[] = [];
    for (const judge of this.state.judges) {
      try {
        calls.push(await judgeAi.judgeRound(this.state, judge));
      } catch (e) {
        this.emit.error({ message: `${judge.name} could not reach a call: ${String(e)}` });
      }
    }
    if (!calls.length) {
      this.emit.error({ message: "Adjudication failed entirely." });
      this.state.phase = "RESULTS";
      this.push();
      return;
    }

    for (const call of calls) {
      const judge = this.state.judges.find((j) => j.id === call.judgeId)!;
      this.say(
        CHANNELS.deliberation,
        judge.id,
        judge.name,
        judge.avatarColor,
        `**My call:** ${call.ranking.join(" > ")}\n${call.reasoning}`,
      );
    }

    const turns = await judgeAi.deliberate(this.state, calls).catch(() => []);
    for (const turn of turns) {
      const judge = this.state.judges.find((j) => j.id === turn.judgeId) ?? this.state.judges[0];
      this.say(CHANNELS.deliberation, judge.id, judge.name, judge.avatarColor, turn.content);
      await sleep(700);
    }

    const { ranking, speaks } = judgeAi.reconcile(calls);
    const chair = this.state.judges[0];
    const [oral, feedback] = await Promise.all([
      judgeAi.oralAdjudication(this.state, chair, ranking, calls).catch(() => ""),
      judgeAi.writtenFeedback(this.state, chair, ranking, speaks),
    ]);

    const humanPos = this.state.humanPosition!;
    const humanTeam = TEAM_OF[humanPos];
    const place = judgeAi.placeOf(ranking, humanTeam);
    const fieldAvg =
      this.state.seats
        .filter((s) => s.personaId !== "human")
        .reduce((sum, s) => sum + (PERSONA_BY_ID[s.personaId]?.elo ?? 1400), 0) / 7;
    const humanDelta = judgeAi.eloDelta(place, db.getElo("human"), fieldAvg);

    this.state.result = {
      ranking,
      chairCall: calls[0].reasoning,
      oral,
      speaks,
      feedback,
      calls,
      humanEloDelta: humanDelta,
    };
    this.state.phase = "RESULTS";
    this.push();

    // Announce, then read the oral adjudication aloud.
    this.system(
      CHANNELS.announcements,
      `**The call:** ` +
        ranking.map((t, i) => `${i + 1}. ${TEAM_NAMES[t]}`).join("  ·  "),
    );
    this.system(
      CHANNELS.feedback,
      `You came **${["first", "second", "third", "fourth"][place - 1]}** with **${speaks[humanPos]}** speaks (${humanDelta >= 0 ? "+" : ""}${humanDelta} Elo).`,
    );
    this.say(CHANNELS.feedback, chair.id, chair.name, chair.avatarColor, feedback[humanPos]);

    // Persist the circuit.
    db.applyResult("human", "You", humanDelta, speaks[humanPos], place === 1);
    for (const seat of this.state.seats) {
      if (seat.personaId === "human") continue;
      const persona = PERSONA_BY_ID[seat.personaId];
      if (!persona) continue;
      const theirPlace = judgeAi.placeOf(ranking, seat.team);
      const delta = judgeAi.eloDelta(theirPlace, db.getElo(seat.personaId), fieldAvg);
      db.applyResult(seat.personaId, persona.name, delta, speaks[seat.position], theirPlace === 1);
    }
    db.saveRound(this.state, place, speaks[humanPos], humanDelta);

    if (oral) {
      await this.playAudio(chair.id, oral, chair.voice);
      this.emit.audioEnd({ personaId: chair.id });
    }
    this.push();
  }
}
