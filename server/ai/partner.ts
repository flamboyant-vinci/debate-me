// Your AI partner during the fifteen minutes of prep, and the shared case notes
// that come out of it. Whatever you agree here is fed into your partner's actual
// speech later, so prep genuinely matters.
import type { Persona, RoundState, Seat, ChatMessage } from "../../src/shared/types.ts";
import {
  PARTNER_OF,
  POSITION_NAMES,
  ROLE_BURDENS,
  TEAM_NAMES,
  TEAM_OF,
} from "../../src/shared/bp.ts";
import { TIER_BRIEF } from "../data/personas.ts";
import { chat } from "./llm.ts";

export interface PrepNotes {
  /** The team line both speakers are committed to. */
  caseLine: string;
  /** What the human said they would cover. */
  humanBurdens: string[];
  /** What the partner said they would cover. */
  partnerBurdens: string[];
  /** Anticipated attacks discussed in prep. */
  anticipated: string[];
}

export const emptyNotes = (): PrepNotes => ({
  caseLine: "",
  humanBurdens: [],
  partnerBurdens: [],
  anticipated: [],
});

function partnerSystem(
  state: RoundState,
  partner: { seat: Seat; persona: Persona },
  humanSeat: Seat,
): string {
  return [
    `You are ${partner.persona.name} (${partner.persona.pronouns}) of ${partner.persona.institution}.`,
    `Skill level: ${TIER_BRIEF[partner.persona.tier]}`,
    `Speaking habits: ${partner.persona.quirks.join("; ")}.`,
    "",
    `You and your partner have just been drawn as ${TEAM_NAMES[partner.seat.team]} in a British ` +
      `Parliamentary round. You are speaking ${POSITION_NAMES[partner.seat.position]} ` +
      `(${partner.seat.position}). Your partner — a real human — is speaking ` +
      `${POSITION_NAMES[humanSeat.position]} (${humanSeat.position}).`,
    "",
    `MOTION: ${state.motion?.text}`,
    state.motion?.infoslide ? `INFO SLIDE: ${state.motion.infoslide}` : "",
    "",
    `Your burden: ${ROLE_BURDENS[partner.seat.position]}`,
    `Their burden: ${ROLE_BURDENS[humanSeat.position]}`,
    "",
    "You are talking in your team's prep chat during the fifteen minutes before the round. Behave like a " +
      "real debater in prep: propose a case line, split the burdens explicitly, stress-test their ideas " +
      "rather than just agreeing, flag the strongest thing the other side will say, and push back when " +
      "they suggest something weak. Talk at your actual skill level — if you are a novice, your ideas " +
      "should be correspondingly thin.",
    "",
    "Write like a chat message: one short paragraph or a few lines, lowercase-casual is fine, no " +
      "markdown headings, no bullet symbols. Never write more than about eighty words.",
  ]
    .filter(Boolean)
    .join("\n");
}

function historyToMessages(history: ChatMessage[]) {
  return history.slice(-24).map((m) => ({
    role: (m.authorId === "human" ? "user" : "assistant") as "user" | "assistant",
    content: m.authorId === "human" ? m.content : m.content,
  }));
}

/** The partner's opening message when the motion drops and prep starts. */
export async function openPrep(
  state: RoundState,
  partner: { seat: Seat; persona: Persona },
  humanSeat: Seat,
): Promise<string> {
  return chat(
    [
      { role: "system", content: partnerSystem(state, partner, humanSeat) },
      {
        role: "user",
        content:
          "Prep has just started. Open the conversation: give your first read on the motion, propose a " +
          "case line, and suggest how you split the material between you.",
      },
    ],
    { reasoningEffort: "medium", temperature: 0.9, maxTokens: 700 },
  );
}

/** A reply to something the human said in prep chat. */
export async function replyInPrep(
  state: RoundState,
  partner: { seat: Seat; persona: Persona },
  humanSeat: Seat,
  history: ChatMessage[],
  minutesLeft: number,
): Promise<string> {
  return chat(
    [
      {
        role: "system",
        content:
          partnerSystem(state, partner, humanSeat) +
          `\n\nThere are about ${minutesLeft} minutes of prep left. ` +
          (minutesLeft <= 3
            ? "Time is nearly up — start locking things down rather than opening new threads."
            : ""),
      },
      ...historyToMessages(history),
    ],
    { reasoningEffort: "low", temperature: 0.9, maxTokens: 600 },
  );
}

/** An unprompted nudge when the human has gone quiet. */
export async function prepNudge(
  state: RoundState,
  partner: { seat: Seat; persona: Persona },
  humanSeat: Seat,
  history: ChatMessage[],
  minutesLeft: number,
): Promise<string> {
  return chat(
    [
      { role: "system", content: partnerSystem(state, partner, humanSeat) },
      ...historyToMessages(history),
      {
        role: "user",
        content:
          `[Your partner has gone quiet. ${minutesLeft} minutes left. Say something useful unprompted — ` +
          "raise the strongest opposition response you can see, or push a piece of analysis further. " +
          "Do not mention that they went quiet.]",
      },
    ],
    { reasoningEffort: "low", temperature: 1.0, maxTokens: 500 },
  );
}

/** Distil the prep conversation into notes the speech generator can use. */
export async function summariseNotes(
  state: RoundState,
  partner: { seat: Seat; persona: Persona },
  humanSeat: Seat,
  history: ChatMessage[],
): Promise<PrepNotes> {
  if (!history.length) return emptyNotes();
  try {
    const raw = await chat(
      [
        {
          role: "system",
          content:
            "Summarise this debate prep conversation as JSON: " +
            '{"caseLine":"","humanBurdens":[],"partnerBurdens":[],"anticipated":[]}. ' +
            `The human speaks ${humanSeat.position}; ${partner.persona.name} speaks ` +
            `${partner.seat.position}. Only record what was actually agreed.`,
        },
        {
          role: "user",
          content: history.map((m) => `${m.authorName}: ${m.content}`).join("\n"),
        },
      ],
      { reasoningEffort: "low", temperature: 0.3, maxTokens: 900, json: true },
    );
    const parsed = JSON.parse(raw) as Partial<PrepNotes>;
    return {
      caseLine: parsed.caseLine ?? "",
      humanBurdens: parsed.humanBurdens ?? [],
      partnerBurdens: parsed.partnerBurdens ?? [],
      anticipated: parsed.anticipated ?? [],
    };
  } catch {
    return emptyNotes();
  }
}

/** Render notes for injection into the partner's speech prompt. */
export function notesForSpeech(notes: PrepNotes): string {
  if (!notes.caseLine && !notes.partnerBurdens.length) return "";
  return [
    "WHAT YOU AGREED IN PREP WITH YOUR PARTNER (you are bound by this):",
    notes.caseLine ? `  Case line: ${notes.caseLine}` : "",
    notes.partnerBurdens.length ? `  You are covering: ${notes.partnerBurdens.join("; ")}` : "",
    notes.humanBurdens.length
      ? `  Your partner is covering (do not take their material): ${notes.humanBurdens.join("; ")}`
      : "",
    notes.anticipated.length ? `  You expected opposition to say: ${notes.anticipated.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function partnerSeatFor(state: RoundState, humanPosition: string) {
  return state.seats.find((s) => s.position === PARTNER_OF[humanPosition as never]);
}

export { TEAM_OF };
