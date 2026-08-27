// British Parliamentary format constants and the role burdens that make a
// speech actually count as that position rather than a generic argument dump.
import type { Half, Position, RoundProfile, Side, TeamId } from "./types.ts";

export const SPEAKING_ORDER: Position[] = [
  "PM",
  "LO",
  "DPM",
  "DLO",
  "MG",
  "MO",
  "GW",
  "OW",
];

export const TEAM_OF: Record<Position, TeamId> = {
  PM: "OG",
  DPM: "OG",
  LO: "OO",
  DLO: "OO",
  MG: "CG",
  GW: "CG",
  MO: "CO",
  OW: "CO",
};

export const TEAM_NAMES: Record<TeamId, string> = {
  OG: "Opening Government",
  OO: "Opening Opposition",
  CG: "Closing Government",
  CO: "Closing Opposition",
};

export const POSITION_NAMES: Record<Position, string> = {
  PM: "Prime Minister",
  LO: "Leader of Opposition",
  DPM: "Deputy Prime Minister",
  DLO: "Deputy Leader of Opposition",
  MG: "Member of Government",
  MO: "Member of Opposition",
  GW: "Government Whip",
  OW: "Opposition Whip",
};

export const SIDE_OF: Record<TeamId, Side> = {
  OG: "gov",
  CG: "gov",
  OO: "opp",
  CO: "opp",
};

export const HALF_OF: Record<TeamId, Half> = {
  OG: "opening",
  OO: "opening",
  CG: "closing",
  CO: "closing",
};

export const PARTNER_OF: Record<Position, Position> = {
  PM: "DPM",
  DPM: "PM",
  LO: "DLO",
  DLO: "LO",
  MG: "GW",
  GW: "MG",
  MO: "OW",
  OW: "MO",
};

/**
 * The layers of analysis that separate a good speech from a winning one, drawn
 * from how finals-level speakers actually build. Every speaker is shown this;
 * how much of it they attempt is gated by tier in TIER_LAYERS.
 */
export const ANALYSIS_STANDARD = `HOW STRONG SPEECHES ARE BUILT — attempt these, do not merely name them:

1. SET THE TEST, do not just argue inside it. Before arguing, say what this round
   should be judged on and why that test is fair. "You may only justify this if you
   can show (a) a real expectation of success, (b) that the people you target are
   culpable, and (c) that no lesser route exists." Then argue against your own test.

2. ALLOCATE THE BURDEN. Say what the other side must prove, and hold them to it.
   "They must show the world without this is better — not merely that this is imperfect."

3. LAYER YOUR CASE WITH "EVEN IF". Win on more than one independent level, so losing
   one does not lose the round. "Even if you accept their entire characterisation of
   the actor, we still win, because the mechanism they rely on cuts the other way."

4. TURN THEIR MATERIAL. The strongest response is not denial but reversal: show their
   own argument proves your case. "Their concern about circumvention proves our point,
   not theirs — it is precisely why the current settlement fails."

5. REBUT ON MULTIPLE LEVELS, in this order: reject the premise; even if the premise
   holds, break the mechanism; even if the mechanism holds, shrink the impact; even if
   the impact stands, show yours outweighs it.

6. CHARACTERISE WITH SPECIFICS. Name real actors, places, cases and numbers. A named
   example does work that "people" and "society" never do.

7. OFFER AN ALTERNATE WORLD. Do not only negate. Describe the counterfactual you are
   defending and why it is better, so the judge is comparing two worlds, not one world
   against an absence.

8. WEIGH COMPARATIVELY at the end: on magnitude, probability, reversibility, and whose
   interests matter most. Tell the judge which comparison decides the round.`;

/**
 * How a speech should SOUND. Analysis and delivery are separate problems: a speech
 * can be structurally perfect and still sound like a system answering a question.
 * Real speeches carry a single narrative through-line and build; they are not a
 * list of correct points read out in order.
 */
export const DELIVERY_STANDARD = `HOW TO SOUND LIKE A DEBATER RATHER THAN A DOCUMENT READ ALOUD:

- Tell ONE story. The speech has a through-line — a single claim about the world that
  everything returns to. Points are not a list; each grows out of the one before it.
  A judge should be able to say afterwards what your speech was ABOUT, in one sentence.

- Carry momentum verbally. Move with spoken transitions — "so what does that actually
  look like", "and here is why that matters", "but notice what they have to defend",
  "let me take them at their best". Never announce structure like a document
  ("Section two", "In conclusion", "Firstly, secondly, thirdly" mechanically).

- Vary the rhythm. Long build, then a short sentence that lands. Fragments are allowed
  for emphasis.

- NEVER reuse the same transition phrase twice in one speech. If you have said "and here
  is why that matters" once, the next impact must arrive differently — through the
  argument itself, through a question, through a consequence. Repeating a stock phrase is
  the single clearest sign of a machine reading a template.

- A verbal habit is a habit, not a formula: it surfaces once or twice across a whole
  speech, never in every paragraph.

- Speak TO the room. Address the chair occasionally, name opponents directly, and refer
  to what the room has just heard — "look at what they are actually claiming here".

- Argue, do not answer. You are persuading a person, not completing a task. No headings,
  no numbered lists read aloud, no summarising what you are about to do in meta terms
  ("I will now address three points" is weak; "their whole case rests on one assumption,
  and it is wrong" is strong).

- Land the ending. Finish on the comparison that decides the round, not on a trailing
  point. Do not stop mid-thought because you ran out of material.

- Write it as continuous spoken prose. No markdown, no bullets, no stage directions,
  no digits where a speaker would say the number in words.`;

/** What a judge expects from this seat. Fed to the model and to feedback. */
export const ROLE_BURDENS: Record<Position, string> = {
  PM:
    "Define the motion clearly and fairly and set the model or characterisation if one is needed. " +
    "Establish the TEST the round should be judged on — the burden both sides must meet — because " +
    "whoever frames the question usually wins it. Explain the status quo, why it fails, and who bears " +
    "that cost. Then run two substantive arguments with full mechanisms. Vagueness here is punished all round.",
  LO:
    "Do not open with scattered rebuttal. First contest or accept the definition, then set out the " +
    "conditions under which government's case could ever succeed — the standard they must meet — and " +
    "show they fail it. Rebut the PM directly and by name on multiple levels. Then build a positive " +
    "opposition case with its own alternate world: what should happen instead, and why that is better.",
  DPM:
    "Rebut the LO head-on, layering your responses: reject the premise, then even if it holds break the " +
    "mechanism, then even if that holds shrink the impact. Turn their material where you can. Defend the " +
    "PM's material against the specific attacks made — by name — and add one new substantive argument. " +
    "Do not restate the PM.",
  DLO:
    "Rebut the government bench, especially the DPM's new material. Defend the LO's case and the test the " +
    "LO set. Add your own substantive extension of opposition's line, and make the alternate world concrete " +
    "— who acts, through what mechanism, with what result.",
  MG:
    "You must EXTEND. Bring genuinely new material the opening did not run — a new actor, a new layer of " +
    "impact, a new mechanism — while staying consistent with OG. Say explicitly what your extension is, so " +
    "the judge cannot miss it. Rebut opening opposition. A rehash of OG is the single most common way " +
    "closing government comes fourth.",
  MO:
    "You must EXTEND for opposition with material distinct from OO, and name your extension explicitly. " +
    "Rebut closing government's extension directly — it is fresh and therefore most vulnerable. Stay " +
    "consistent with OO while showing what your team added that they did not.",
  GW:
    "No new constructive material. Rebut closing opposition, then summarise the whole debate BY CLASH, not " +
    "in speaking order: identify the two or three questions the round turned on, say who won each and why, " +
    "and weigh them against each other. Organise around themes — principle, process, outcome — as finals " +
    "whips do. Your job is to make the judge's decision for them, with your half winning.",
  OW:
    "No new constructive material. Rebut, then give a comparative summary organised BY CLASH and by theme, " +
    "not chronologically. Weigh why opposition wins overall and why your extension mattered more than " +
    "closing government's. Speaking last, you must address what the GW just said, and close by naming the " +
    "single comparison on which the round should be decided.",
};

/**
 * Measured delivery rate in words per second for each pacing step (Rumik mulberry,
 * same text synthesised at each setting). Speech length is derived from these rather
 * than from one global constant, because a fast speaker fits far more into the slot.
 */
export const PACING_WPS: Record<string, number> = {
  "very slow": 1.55,
  slow: 1.75,
  conversational: 1.97,
  brisk: 2.09,
  fast: 2.24,
  very_fast: 2.77,
};

/** Words this speaker can actually deliver in the slot, at their own pace. */
export function wordsForSpeech(speechMs: number, pacing = "fast"): number {
  const wps = PACING_WPS[pacing] ?? PACING_WPS.fast;
  // Leave a little headroom so a speaker lands inside time rather than being cut.
  return Math.round((speechMs / 1000) * wps * 0.92);
}

export const PROFILES: Record<RoundProfile["id"], RoundProfile> = {
  full: {
    id: "full",
    label: "Full round — 15 min prep, 7 min speeches",
    prepMs: 15 * 60_000,
    speechMs: 7 * 60_000,
    graceMs: 15_000,
    // Calibrated against measured delivery. Rumik speaks at 1.85-2.3 words/second
    // depending on the persona's voice description, and the model overshoots this
    // target by roughly 17%, so it is set against the slow end of that range —
    // otherwise every speaker is cut off, which is not what a real round looks like.
    targetWords: 640,
  },
  fast: {
    id: "fast",
    label: "Fast round — 3 min prep, 2 min speeches",
    prepMs: 3 * 60_000,
    speechMs: 2 * 60_000,
    graceMs: 10_000,
    targetWords: 180,
  },
};

/** Bells: one minute in, one minute to go, and time. */
export function bellsFor(profile: RoundProfile): number[] {
  const protectedMs = profile.speechMs <= 3 * 60_000 ? 20_000 : 60_000;
  return [protectedMs, profile.speechMs - protectedMs, profile.speechMs];
}

/** POIs may only be offered outside protected time. */
export function poiWindow(profile: RoundProfile): [number, number] {
  const protectedMs = profile.speechMs <= 3 * 60_000 ? 20_000 : 60_000;
  return [protectedMs, profile.speechMs - protectedMs];
}

export function isProtected(elapsedMs: number, profile: RoundProfile): boolean {
  const [open, close] = poiWindow(profile);
  return elapsedMs < open || elapsedMs > close;
}

/** Teams that may offer a POI to the given position (the other side only). */
export function opposingTeams(position: Position): TeamId[] {
  const side = SIDE_OF[TEAM_OF[position]];
  return (Object.keys(SIDE_OF) as TeamId[]).filter((t) => SIDE_OF[t] !== side);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
