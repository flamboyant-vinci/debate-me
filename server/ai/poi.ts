// Points of Information, in both directions.
import { randomUUID } from "node:crypto";
import type { Persona, PoiRecord, Position, RoundState, Seat } from "../../src/shared/types.ts";
import { POSITION_NAMES, TEAM_NAMES, TEAM_OF, SIDE_OF } from "../../src/shared/bp.ts";
import { TIER_POI_APPETITE, TIER_BRIEF } from "../data/personas.ts";
import { chat } from "./llm.ts";
import { withOp } from "./trace.ts";
import { roundDigest } from "./speech.ts";

/** Speakers on the opposing side who are not currently speaking. */
export function eligibleOfferers(state: RoundState, speaking: Position): Seat[] {
  const side = SIDE_OF[TEAM_OF[speaking]];
  return state.seats.filter(
    (s) => s.position !== speaking && SIDE_OF[TEAM_OF[s.position]] !== side,
  );
}

/** Whether this persona bothers standing up right now. */
export function wantsToOffer(persona: Persona, poisAlreadyOffered: number): boolean {
  const base = TIER_POI_APPETITE[persona.tier];
  // Diminishing: nobody stands up eight times without irritating the judge.
  return Math.random() < base / (1 + poisAlreadyOffered * 0.8);
}

/** Write the POI an AI speaker would offer against what is being said right now. */
export async function composePoi(
  state: RoundState,
  offerer: { seat: Seat; persona: Persona },
  targetPosition: Position,
  liveTranscript: string,
): Promise<string> {
  const text = await withOp("poi.compose", { personaId: offerer.persona.id }, () =>
    chat(
    [
      {
        role: "system",
        content: [
          `You are ${offerer.persona.name}, ${POSITION_NAMES[offerer.seat.position]} for ` +
            `${TEAM_NAMES[offerer.seat.team]} in a British Parliamentary round.`,
          `Skill level: ${TIER_BRIEF[offerer.persona.tier]}`,
          `You are standing to offer a Point of Information to the ${POSITION_NAMES[targetPosition]}.`,
          "Write ONLY the POI itself, as spoken: one or two sentences, under thirty words, phrased as a " +
            "question or a sharp challenge. It must attack something they have JUST said, not something " +
            "generic. No preamble like 'point of information' — that is implied. No quotes.",
        ].join("\n"),
      },
      {
        role: "user",
        content:
          `Motion: ${state.motion?.text}\n\nWhat they are saying right now:\n${liveTranscript.slice(-1800)}`,
      },
    ],
    { role: "fast", reasoningEffort: "low", temperature: 0.95, maxTokens: 300 },
  ));
  return text.replace(/^["“]|["”]$/g, "").trim();
}

export function makePoi(
  fromId: string | "human",
  fromName: string,
  text: string,
  offeredAtMs: number,
): PoiRecord {
  return { id: randomUUID(), fromPersonaId: fromId, fromName, text, offeredAtMs, status: "offered" };
}

/**
 * Does the AI speaker take the human's POI? Stronger speakers take one or two and
 * bat them away; novices panic and wave everything down.
 */
export function decideAcceptance(
  persona: Persona,
  alreadyAccepted: number,
  elapsedMs: number,
  speechMs: number,
): boolean {
  if (alreadyAccepted >= 2) return false;
  // Nobody takes a POI in the last stretch — they are running out of time.
  if (elapsedMs > speechMs * 0.8) return false;
  const byTier: Record<Persona["tier"], number> = {
    novice: 0.25,
    proam: 0.45,
    open: 0.6,
    breaking: 0.7,
    finalist: 0.75,
  };
  return Math.random() < byTier[persona.tier] / (1 + alreadyAccepted);
}

/** The AI speaker's spoken answer to an accepted POI, plus the bridge back. */
export async function answerPoi(
  state: RoundState,
  speaker: { seat: Seat; persona: Persona },
  poi: PoiRecord,
  speechSoFar: string,
): Promise<string> {
  return chat(
    [
      {
        role: "system",
        content: [
          `You are ${speaker.persona.name}, ${POSITION_NAMES[speaker.seat.position]} for ` +
            `${TEAM_NAMES[speaker.seat.team]}, mid-speech in a British Parliamentary round.`,
          `Skill level: ${TIER_BRIEF[speaker.persona.tier]}`,
          "You have just accepted a Point of Information. Answer it aloud in two or three sentences, " +
            "then return to your speech with a short bridge such as 'but as I was saying'. " +
            "Answer at your actual skill level — a novice would fumble it or simply repeat themselves. " +
            "Spoken word only: no markdown, no stage directions, no quotes.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Motion: ${state.motion?.text}`,
          "",
          `The POI, from ${poi.fromName}: "${poi.text}"`,
          "",
          `What you had been saying:\n${speechSoFar.slice(-1500)}`,
        ].join("\n"),
      },
    ],
    { reasoningEffort: "low", temperature: 0.9, maxTokens: 500 },
  );
}

/**
 * How an AI speaker verbally waves a POI down. Spoken over the top, briefly.
 */
export function declineLine(persona: Persona): string {
  const lines = [
    "No thank you.",
    "Not at this time.",
    "I will come to that.",
    "No, thank you, I am building an argument.",
    "Not right now, thank you.",
  ];
  if (persona.tier === "novice") return "Um, no thank you.";
  return lines[Math.floor(Math.random() * lines.length)];
}

/** Context digest used when the human offers a POI during an AI speech. */
export function poiContext(state: RoundState): string {
  return roundDigest(state, state.speeches.length);
}
