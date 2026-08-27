// Speech generation. Two stages: a structured plan (so the speech has real
// architecture rather than drifting prose), then streamed spoken prose built from
// that plan. The prose is streamed because synthesis and playback start before the
// model has finished writing.
import type {
  Argument,
  Persona,
  Position,
  RoundState,
  Seat,
  SpeechRecord,
} from "../../src/shared/types.ts";
import {
  ANALYSIS_STANDARD,
  wordsForSpeech,
  DELIVERY_STANDARD,
  HALF_OF,
  PARTNER_OF,
  POSITION_NAMES,
  ROLE_BURDENS,
  SIDE_OF,
  TEAM_NAMES,
  TEAM_OF,
} from "../../src/shared/bp.ts";
import { TIER_BRIEF, TIER_LAYERS } from "../data/personas.ts";
import { chat, chatJson, chatStream } from "./llm.ts";
import { withOp } from "./trace.ts";

export interface SpeechPlan {
  /** One sentence: what this speech is fundamentally arguing. */
  caseLine: string;
  /** The test the round should be judged on — set it rather than argue inside it. */
  burden: string;
  /** Direct responses, most important first, each attacking a named level. */
  rebuttals: Array<{ target: string; response: string; level?: string }>;
  /** Their own material reversed to prove your case. */
  turns: Array<{ target: string; turn: string }>;
  arguments: Argument[];
  /** Independent fallback levels, so losing one does not lose the round. */
  evenIf: string[];
  /** The alternate world being defended, so the judge compares two worlds. */
  counterModel: string;
  /** Comparative weighing; whips live or die on this. */
  weighing: string;
}

const HOUSE = `You are competing in a British Parliamentary debate round. Four teams of two:
Opening Government (PM, DPM), Opening Opposition (LO, DLO), Closing Government (MG, GW),
Closing Opposition (MO, OW). Teams are ranked 1st to 4th. Your closing half is competing
against your own opening half as well as against the other side.`;

/** Everything said so far, compressed enough to fit comfortably in context. */
export function roundDigest(state: RoundState, upTo: number): string {
  const lines: string[] = [];
  lines.push(`MOTION: ${state.motion?.text ?? "(not yet released)"}`);
  if (state.motion?.infoslide) lines.push(`INFO SLIDE: ${state.motion.infoslide}`);
  lines.push("");
  lines.push("THE TABLE:");
  for (const seat of state.seats) {
    lines.push(
      `  ${seat.position} (${TEAM_NAMES[seat.team]}) — ${seat.displayName}` +
        (seat.personaId === "human" ? " [the human you are debating]" : ""),
    );
  }
  lines.push("");

  const prior = state.speeches.slice(0, upTo);
  if (!prior.length) {
    lines.push("No speeches yet. You are opening the debate.");
    return lines.join("\n");
  }

  lines.push("SPEECHES SO FAR:");
  for (const s of prior) {
    lines.push("");
    lines.push(`--- ${s.position} (${TEAM_NAMES[s.team]}), ${s.speakerName} ---`);
    if (s.arguments.length) {
      for (const a of s.arguments) {
        lines.push(`  • ${a.claim} — mechanism: ${a.mechanism} — impact: ${a.impact}`);
      }
    }
    // Token budget is tight (8000/min on the free tier), so older speeches are
    // represented by their extracted arguments alone; only the two speeches you
    // must actually rebut carry their real words.
    const fromEnd = prior.length - prior.indexOf(s);
    const budget = fromEnd <= 2 ? 1400 : s.arguments.length ? 0 : 500;
    if (budget) {
      lines.push(
        `  Transcript: ${s.transcript.slice(0, budget)}${s.transcript.length > budget ? " …" : ""}`,
      );
    }
    const accepted = s.pois.filter((p) => p.status === "accepted");
    for (const p of accepted) {
      lines.push(`  POI from ${p.fromName}: "${p.text}" — answered: "${p.answer ?? "(no answer)"}"`);
    }
  }
  return lines.join("\n");
}

function positionBrief(position: Position, state: RoundState): string {
  const team = TEAM_OF[position];
  const half = HALF_OF[team];
  const side = SIDE_OF[team];
  const partnerSeat = state.seats.find((s) => s.position === PARTNER_OF[position]);
  const openingAlly = side === "gov" ? "Opening Government" : "Opening Opposition";

  const lines = [
    `YOUR POSITION: ${POSITION_NAMES[position]} (${position}) for ${TEAM_NAMES[team]}.`,
    `YOUR PARTNER: ${partnerSeat?.displayName ?? "unknown"} (${PARTNER_OF[position]}).`,
    `YOUR BURDEN: ${ROLE_BURDENS[position]}`,
  ];
  if (half === "closing") {
    lines.push(
      `You are the CLOSING half. ${openingAlly} is on your side of the motion but is a RIVAL TEAM you ` +
        `must beat. Do not contradict them, but you must be demonstrably additive — the judge has to be ` +
        `able to say what your team brought that they did not.`,
    );
  } else {
    lines.push(
      `You are the OPENING half. Set up the debate so well that the closing half struggles to find ` +
        `anything left to extend on.`,
    );
  }
  return lines.join("\n");
}

function personaBrief(persona: Persona): string {
  return [
    `YOU ARE: ${persona.name} (${persona.pronouns}) of ${persona.institution}.`,
    `SKILL LEVEL: ${TIER_BRIEF[persona.tier]}`,
    `WHAT YOU CAN ACTUALLY DO AT THIS LEVEL: ${TIER_LAYERS[persona.tier]}`,
    `SPEAKING HABITS — surface these ONCE OR TWICE across the whole speech, never every ` +
      `paragraph, or you will sound like a template: ${persona.quirks.join("; ")}.`,
  ].join("\n");
}

export async function planSpeech(
  state: RoundState,
  seat: Seat,
  persona: Persona,
  signal?: AbortSignal,
): Promise<SpeechPlan> {
  const upTo = state.speeches.length;
  const isWhip = seat.position === "GW" || seat.position === "OW";
  const words = wordsForSpeech(state.profile.speechMs, persona.voice.pacing);

  // Layers have to fit the clock. A seven-minute speech can carry a burden, two
  // mechanised arguments, turns and even-if layering; a two-minute speech cannot,
  // and cramming them produces telegraphic notes instead of a speech.
  const room =
    words >= 500
      ? "You have room for the full set: a burden, two or three mechanised arguments, turns, " +
        "even-if layering and a counter-model. Develop each properly."
      : words >= 300
        ? "You have limited room. Plan a burden, TWO arguments, and at most ONE even-if layer. " +
          "Depth beats coverage — a fully mechanised argument is worth more than three gestures."
        : "You have very little room — this is a short speech. Plan ONE or TWO arguments and " +
          "nothing else beyond brief rebuttal. Leave burden, turns, evenIf and counterModel EMPTY " +
          "unless one of them genuinely replaces an argument. Cramming every layer into this many " +
          "words produces unspeakable, compressed notes rather than a speech.";

  const system = [
    HOUSE,
    "",
    personaBrief(persona),
    "",
    positionBrief(seat.position, state),
    "",
    ANALYSIS_STANDARD,
    "",
    `LENGTH: this speech will be about ${words} words when spoken. ${room}`,
    "",
    "Plan your speech. Respond with JSON only, matching this shape:",
    `{
  "caseLine": "one sentence — the single claim this whole speech returns to",
  "burden": "the test this round should be judged on, and what the other side must prove",
  "rebuttals": [{"target": "who said what, named", "response": "your answer", "level": "premise | mechanism | impact | weighing"}],
  "turns": [{"target": "their argument", "turn": "how it actually proves your case"}],
  "arguments": [{"claim": "...", "mechanism": "the causal steps, named and spelled out", "impact": "which real actors are affected, how much, why it matters"}],
  "evenIf": ["even if they win X, we still win because Y"],
  "counterModel": "the alternate world you defend, concretely: who acts, how, with what result",
  "weighing": "the single comparison that should decide the round, on magnitude, probability and whose interests matter most"
}`,
    "Leave a field as an empty string or empty array if your skill level would not reach it — " +
      "a novice genuinely does not set burdens or layer with 'even if'. Do not fake sophistication " +
      "you do not have.",
    isWhip
      ? "You are a WHIP: `arguments` and `counterModel` must be EMPTY. Put your comparative clash analysis in `weighing` and " +
        "your responses in `rebuttals`. New constructive material is penalised."
      : `Plan ${persona.tier === "novice" ? "1" : persona.tier === "proam" ? "2" : "2 or 3"} arguments.`,
    "Write the plan at your actual skill level. If your level means you would rebut badly, forget to " +
      "rebut, or assert an impact without a mechanism, then genuinely do that — the plan should be " +
      "as weak as the speaker is.",
  ].join("\n");

  const plan = await withOp("speech.plan", { personaId: persona.id, position: seat.position }, () =>
    chatJson<SpeechPlan>(
    [
      { role: "system", content: system },
      { role: "user", content: roundDigest(state, upTo) },
    ],
    // Planned on the secondary model: it keeps the plan off the same per-model
    // token budget the prose needs a moment later, which roughly doubles how
    // much of a round fits inside the free tier's limit.
    { role: "fast", reasoningEffort: "medium", temperature: 0.9, maxTokens: 1600, signal },
  ));

  return {
    caseLine: plan.caseLine ?? "",
    burden: plan.burden ?? "",
    rebuttals: Array.isArray(plan.rebuttals) ? plan.rebuttals : [],
    turns: Array.isArray(plan.turns) ? plan.turns : [],
    arguments: Array.isArray(plan.arguments) ? plan.arguments : [],
    evenIf: Array.isArray(plan.evenIf) ? plan.evenIf : [],
    counterModel: plan.counterModel ?? "",
    weighing: plan.weighing ?? "",
  };
}

/**
 * Stream the spoken prose for a planned speech. Output is what the speaker says
 * aloud — no headings, no stage directions, nothing that would sound wrong read out.
 */
export async function* streamSpeech(
  state: RoundState,
  seat: Seat,
  persona: Persona,
  plan: SpeechPlan,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const words = wordsForSpeech(state.profile.speechMs, persona.voice.pacing);
  const speakerBefore = state.speeches[state.speeches.length - 1];

  const system = [
    HOUSE,
    "",
    personaBrief(persona),
    "",
    positionBrief(seat.position, state),
    "",
    DELIVERY_STANDARD,
    "",
    "Deliver this speech ALOUD. Rules for the text you produce:",
    "- It is spoken word. No markdown, no headings, no bullet points, no stage directions, no numbers " +
      "in digits where a speaker would say them in words.",
    "- Address the chair as 'Madam Speaker' or 'Mr Speaker' occasionally, not constantly.",
    "- Refer to other speakers by name and position, as debaters actually do.",
    "- Signpost verbally: 'my first argument is', 'let me turn to their case', 'the comparison is this'.",
    `- HARD LIMIT: ${words} words. That is exactly what fits the speaking time, and the chair will cut ` +
      `you off mid-sentence if you run over — so land your conclusion before you get there. Budget it: ` +
      `roughly ${Math.round(words * 0.2)} words of rebuttal, ${Math.round(words * 0.6)} of substantive ` +
      `material, ${Math.round(words * 0.2)} of weighing and conclusion.`,
    "- Your habits and skill level must be audible in the delivery, not described.",
    "- Do not narrate that you are following a plan. Just speak.",
    speakerBefore
      ? `- The previous speaker was ${speakerBefore.speakerName} (${speakerBefore.position}). Engage with ` +
        `what they actually said.`
      : "- You are opening the debate.",
  ].join("\n");

  const user = [
    roundDigest(state, state.speeches.length),
    "",
    "YOUR PLAN:",
    `Case line: ${plan.caseLine}`,
    plan.burden ? `The test you are setting: ${plan.burden}` : "",
    plan.rebuttals.length
      ? "Rebuttals:\n" +
        plan.rebuttals
          .map((r) => `  - vs ${r.target}${r.level ? ` [${r.level}]` : ""}: ${r.response}`)
          .join("\n")
      : "Rebuttals: none planned.",
    plan.turns?.length
      ? "Turns:\n" + plan.turns.map((t) => `  - ${t.target} → ${t.turn}`).join("\n")
      : "",
    plan.evenIf?.length ? "Even-if layers:\n" + plan.evenIf.map((e) => `  - ${e}`).join("\n") : "",
    plan.counterModel ? `Alternate world you defend: ${plan.counterModel}` : "",
    plan.arguments.length
      ? "Arguments:\n" +
        plan.arguments
          .map((a) => `  - ${a.claim}\n    mechanism: ${a.mechanism}\n    impact: ${a.impact}`)
          .join("\n")
      : "Arguments: none (whip speech — summary only).",
    `Weighing: ${plan.weighing}`,
    "",
    "Now deliver the speech.",
  ].join("\n");

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const maxTokens = Math.round(words * 2.2) + 400;

  let produced = 0;
  for await (const delta of chatStream(messages, {
    reasoningEffort: "low",
    temperature: 0.95,
    maxTokens,
    signal,
  })) {
    produced += delta.length;
    yield delta;
  }

  // A speaker who says nothing at all is never the right outcome. If reasoning
  // still swallowed the budget, take one non-streaming run with a wider cap.
  if (produced === 0 && !signal?.aborted) {
    const text = await chat(messages, {
      reasoningEffort: "low",
      temperature: 0.95,
      maxTokens: maxTokens + 4000,
      signal,
    });
    if (text) yield text;
  }
}

/**
 * Extract the argument structure of a delivered speech so later speakers can
 * rebut it precisely. Runs on the cheap model while the speech is still playing.
 */
export async function extractArguments(speech: SpeechRecord): Promise<Argument[]> {
  if (!speech.transcript.trim()) return [];
  try {
    const result = await withOp("speech.extract", { position: speech.position }, () =>
      chatJson<{ arguments: Argument[] }>(
      [
        {
          role: "system",
          content:
            "Extract the substantive arguments from this debate speech. Respond with JSON: " +
            '{"arguments":[{"claim":"","mechanism":"","impact":""}]}. Be faithful — if the speaker ' +
            "asserted an impact with no mechanism, leave mechanism as an empty string rather than " +
            "inventing one. Include at most four. Rebuttal is not an argument.",
        },
        { role: "user", content: speech.transcript.slice(0, 12000) },
      ],
      { role: "fast", reasoningEffort: "low", temperature: 0.3, maxTokens: 1200 },
    ));
    return Array.isArray(result.arguments) ? result.arguments.slice(0, 4) : [];
  } catch (err) {
    // Not fatal — later speakers fall back to raw transcript — but silence here
    // once hid a hard 400 for an entire session, so it is always reported.
    console.error(`[speech] argument extraction failed for ${speech.position}:`, String(err).slice(0, 200));
    return [];
  }
}

/** A one-line reaction your partner whispers while you are speaking. */
export async function benchWhisper(
  state: RoundState,
  persona: Persona,
  transcriptSoFar: string,
): Promise<string> {
  return chat(
    [
      {
        role: "system",
        content:
          `You are ${persona.name}, sitting next to your partner while they speak in a BP round. ` +
          "Whisper ONE short line of support or guidance — under fifteen words, the kind of thing a " +
          "partner actually scribbles on a note. No preamble, no quotes.",
      },
      {
        role: "user",
        content: `Motion: ${state.motion?.text}\n\nWhat they have said so far:\n${transcriptSoFar.slice(-1500)}`,
      },
    ],
    { role: "fast", reasoningEffort: "low", temperature: 0.9, maxTokens: 200 },
  );
}
