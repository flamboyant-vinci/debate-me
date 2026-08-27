// Domain model for a British Parliamentary round. Shared verbatim between the
// authoritative server and the browser renderer.

export type TeamId = "OG" | "OO" | "CG" | "CO";
export type Position = "PM" | "LO" | "DPM" | "DLO" | "MG" | "MO" | "GW" | "OW";
export type Side = "gov" | "opp";
export type Half = "opening" | "closing";

export type SkillTier = "novice" | "proam" | "open" | "breaking" | "finalist";

export type Phase =
  | "LOBBY"
  | "DRAW"
  | "MOTION"
  | "PREP"
  | "ROUND"
  | "DELIBERATION"
  | "RESULTS";

/** Mulberry's documented pacing steps, measured at 118/125/134/166 wpm. */
export type Pacing = "very slow" | "slow" | "conversational" | "brisk" | "fast" | "very_fast";

/** Mulberry's documented emotion values. */
export type VoiceEmotion =
  | "neutral"
  | "energetic"
  | "excited"
  | "sad"
  | "sarcastic"
  | "dry"
  | "crying"
  | "angry";

export interface VoiceProfile {
  /** Rumik model. `mulberry` is description-steered, `muga` supports inline emotion tags. */
  model: "mulberry" | "muga";
  speaker?: string;
  /**
   * Identity only — gender, age, accent, timbre, role. Pacing and emotion are kept
   * separate so a speaker's mood can change mid-round without their voice changing
   * identity along with it.
   */
  description?: string;
  pacing?: Pacing;
  emotion?: VoiceEmotion;
  intensity?: "low" | "med" | "high";
}

export interface Persona {
  id: string;
  name: string;
  handle: string;
  pronouns: string;
  institution: string;
  tier: SkillTier;
  elo: number;
  /** Short in-character bio shown in the member list hovercard. */
  bio: string;
  /** Stylistic habits fed into the speech prompt and surfaced in feedback. */
  quirks: string[];
  avatarColor: string;
  voice: VoiceProfile;
}

export interface JudgePersona {
  id: string;
  name: string;
  handle: string;
  pronouns: string;
  institution: string;
  /** How reliably they track the round. Drives how much they actually notice. */
  competence: SkillTier;
  /** The axis on which this judge is predictably skewed. */
  bias: string;
  avatarColor: string;
  voice: VoiceProfile;
}

export interface Motion {
  id: string;
  text: string;
  /** Optional info slide released with the motion. */
  infoslide?: string;
  theme: string;
  difficulty: "novice" | "open" | "hard";
}

/** A seat at the table: either you, or an AI persona. */
export interface Seat {
  position: Position;
  team: TeamId;
  personaId: string | "human";
  displayName: string;
}

export interface Argument {
  /** Short label used for clash-mapping across speeches. */
  claim: string;
  mechanism: string;
  impact: string;
}

export interface SpeechRecord {
  position: Position;
  team: TeamId;
  speakerName: string;
  personaId: string | "human";
  /** Full text as delivered (STT output for the human). */
  transcript: string;
  /** Structured plan the model wrote before prose; empty for the human. */
  arguments: Argument[];
  startedAt: number;
  durationMs: number;
  /** POIs offered during this speech. */
  pois: PoiRecord[];
}

export interface PoiRecord {
  id: string;
  fromPersonaId: string | "human";
  fromName: string;
  text: string;
  offeredAtMs: number;
  status: "offered" | "accepted" | "declined" | "expired";
  /** Answer given by the speaker, if accepted. */
  answer?: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  authorId: string | "human" | "system";
  authorName: string;
  authorColor: string;
  content: string;
  ts: number;
  /** Renders as an italic system line rather than a normal message. */
  system?: boolean;
}

export interface JudgeCall {
  judgeId: string;
  judgeName: string;
  ranking: TeamId[];
  reasoning: string;
  speaks: Record<Position, number>;
}

export interface RoundResult {
  ranking: TeamId[];
  chairCall: string;
  /** Oral adjudication script, delivered aloud by the chair. */
  oral: string;
  speaks: Record<Position, number>;
  feedback: Record<Position, string>;
  calls: JudgeCall[];
  humanEloDelta: number;
}

export interface SpeechClock {
  /** Server timestamp the current speech started, or null between speeches. */
  startedAt: number | null;
  /** Speech length for this round profile. */
  lengthMs: number;
  /** Grace allowed past the final bell before a hard cut. */
  graceMs: number;
  paused: boolean;
  pausedElapsedMs: number;
}

export interface RoundProfile {
  id: "full" | "fast";
  label: string;
  prepMs: number;
  speechMs: number;
  graceMs: number;
  /** Target words the AI writes; roughly 150 wpm delivered. */
  targetWords: number;
}

export interface RoundState {
  id: string;
  phase: Phase;
  profile: RoundProfile;
  motion: Motion | null;
  seats: Seat[];
  humanPosition: Position | null;
  /** Index into SPEAKING_ORDER of the speech in progress or next up. */
  speechIndex: number;
  clock: SpeechClock;
  /** Countdown deadline for PREP, or null. */
  prepEndsAt: number | null;
  speeches: SpeechRecord[];
  /** POIs currently standing during the live speech. */
  standingPois: PoiRecord[];
  judges: JudgePersona[];
  result: RoundResult | null;
  /** Rumik characters billed this round, for the cost meter. */
  ttsChars: number;
  /** Who is mid-utterance right now, for the speaking ring. */
  speakingPersonaId: string | null;
}

export interface CircuitStanding {
  personaId: string;
  name: string;
  elo: number;
  rounds: number;
  avgSpeaks: number;
  firsts: number;
}

export interface RoundHistoryEntry {
  id: string;
  motion: string;
  humanPosition: Position;
  humanTeam: TeamId;
  place: number;
  speaks: number;
  eloDelta: number;
  endedAt: number;
}

/** Socket.IO server -> client events. */
export interface ServerEvents {
  state: (state: RoundState) => void;
  chat: (message: ChatMessage) => void;
  /** Incremental transcript for the speech in progress. */
  transcript: (payload: { position: Position; text: string; final: boolean }) => void;
  /** Base64 WAV chunk to enqueue for playback. */
  audio: (payload: { personaId: string; seq: number; wav: string; text: string }) => void;
  audioEnd: (payload: { personaId: string }) => void;
  error: (payload: { message: string }) => void;
}

/** Socket.IO client -> server events. */
export interface ClientEvents {
  join: (payload: { roundId?: string }) => void;
  startRound: (payload: {
    profileId: RoundProfile["id"];
    position?: Position | "random";
    /** Calibre of the whole AI field, or per-seat overrides. */
    fieldLevel?: SkillTier | "mixed";
    levels?: Partial<Record<Position, SkillTier>>;
  }) => void;
  sendChat: (payload: { channelId: string; content: string }) => void;
  beginSpeech: () => void;
  endSpeech: () => void;
  /** Opus/webm chunk from the mic, base64. */
  micChunk: (payload: { audio: string; seq: number }) => void;
  respondToPoi: (payload: { poiId: string; accept: boolean }) => void;
  offerPoi: (payload: { text: string }) => void;
  advance: () => void;
}
