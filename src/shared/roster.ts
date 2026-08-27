// The circuit: recurring debaters and adjudicators. A persona's voice, tier and
// quirks are stable across rounds so "Aditya Rao" always sounds and argues like
// the same person, and you learn to read the room the way you would in real life.
import type { JudgePersona, Persona, SkillTier } from "./types.ts";

/** How a tier is expressed in a speech. Injected into the generation prompt. */
export const TIER_BRIEF: Record<SkillTier, string> = {
  novice:
    "You are a first-year novice. You have one real argument and you pad. You assert impacts without " +
    "mechanising them, you often forget to rebut at all, you signpost badly or not at all, and you " +
    "sometimes drift off the motion or restate your partner. You run short and finish early, or ramble. " +
    "You are earnest and likeable but the analysis is thin.",
  proam:
    "You are a pro-am speaker in your second semester. You have structure and two arguments, but your " +
    "mechanisms skip a step and your impacts are stated rather than weighed. You rebut the loudest point " +
    "rather than the most important one. Occasional filler and one slightly clumsy metaphor.",
  open:
    "You are a solid open speaker. Clean signposting, two well-mechanised arguments, direct rebuttal that " +
    "names the speaker and the point, and some comparative weighing at the end. Not flashy, but reliable.",
  breaking:
    "You are a breaking speaker at a good tournament. You identify the real clash early, you characterise " +
    "the actors with plausible specifics, your mechanisms have named steps, and you weigh comparatively on " +
    "magnitude, probability and who matters most. You pre-empt the obvious response.",
  finalist:
    "You are a finalist-level speaker. You reframe the debate on your terms in the first thirty seconds, " +
    "your analysis is layered (even if we lose X, we still win because Y), your characterisation is " +
    "specific and human, and your weighing tells the judge exactly which comparison decides the round. " +
    "Economical, controlled, no wasted sentence.",
};

/**
 * Which layers of the analysis standard a speaker at this tier actually reaches.
 * This is where skill difference becomes audible: a novice is not merely told to
 * write badly, they are structurally denied the tools a finalist uses.
 */
export const TIER_LAYERS: Record<SkillTier, string> = {
  novice:
    "Attempt ONLY: one argument, stated. You do not set a test, you do not allocate burdens, you do " +
    "not layer with 'even if', you do not turn material, and you frequently forget to rebut at all. " +
    "Your impacts are asserted rather than mechanised.",
  proam:
    "Attempt: rebuttal (usually of the loudest point rather than the most important), and two arguments " +
    "with partial mechanisms. You do NOT set the test, do not layer with 'even if', and do not turn " +
    "material. Your weighing is a restatement of your impacts rather than a comparison.",
  open:
    "Attempt: direct rebuttal naming the speaker and point, two well-mechanised arguments, a stated " +
    "burden on the other side, and comparative weighing at the end. You may attempt ONE 'even if' but " +
    "do not sustain layering, and you rarely turn material.",
  breaking:
    "Attempt: the test the round should be judged on, burden allocation, multi-level rebuttal (premise, " +
    "then mechanism, then impact), at least one genuine turn, specific named characterisation, and " +
    "comparative weighing on magnitude and probability.",
  finalist:
    "Attempt the full standard: reframe the round on your terms in the opening thirty seconds, set the " +
    "test and defend its fairness, layer the case so that losing one level does not lose the round, turn " +
    "their strongest material against them, characterise with real named specifics, offer an alternate " +
    "world, and close by naming the single comparison that decides the debate. Economical, controlled, " +
    "no wasted sentence.",
};

/** Roughly how likely this tier is to offer a POI in any given open window. */
export const TIER_POI_APPETITE: Record<SkillTier, number> = {
  novice: 0.12,
  proam: 0.28,
  open: 0.45,
  breaking: 0.6,
  finalist: 0.7,
};

export const DEBATERS: Persona[] = [
  {
    id: "aditya-rao",
    name: "Aditya Rao",
    handle: "adi",
    pronouns: "he/him",
    institution: "St. Xavier's",
    tier: "finalist",
    elo: 1720,
    bio: "Two-time national finalist. Reframes the motion before you have finished reading it.",
    quirks: [
      "opens by naming the single question the round turns on",
      "says 'and here is why that matters' before every impact",
      "very controlled pace, almost slow, never rushed",
    ],
    avatarColor: "#5865f2",
    voice: {
      model: "mulberry",
      speaker: "adam",
      description:
        "a male 20s indian english voice, smooth timbre, formal register, like a competitive debater",
      pacing: "fast",
      emotion: "energetic",
      intensity: "med",
    },
  },
  {
    id: "meera-krishnan",
    name: "Meera Krishnan",
    handle: "meerak",
    pronouns: "she/her",
    institution: "NLS",
    tier: "finalist",
    elo: 1695,
    bio: "Law school whip specialist. Will summarise your case better than you did, then bury it.",
    quirks: [
      "structures whips as numbered clashes",
      "uses 'even if' layering constantly",
      "crisp consonants, rising emphasis on the weighing",
    ],
    avatarColor: "#eb459e",
    voice: {
      model: "mulberry",
      speaker: "siya",
      description:
        "a female 20s indian english voice, crisp timbre, formal register, like a courtroom advocate",
      pacing: "very_fast",
      emotion: "energetic",
      intensity: "high",
    },
  },
  {
    id: "james-whitfield",
    name: "James Whitfield",
    handle: "jwhit",
    pronouns: "he/him",
    institution: "Durham",
    tier: "breaking",
    elo: 1610,
    bio: "Breaks at most things. Excellent mechanisms, occasionally forgets to weigh.",
    quirks: [
      "walks through mechanisms in explicit numbered steps",
      "says 'so what does that actually look like'",
      "slightly too fast in the first minute",
    ],
    avatarColor: "#3ba55c",
    voice: {
      model: "mulberry",
      speaker: "theo",
      description:
        "a male 20s british voice, bright timbre, formal register, like a competitive debater",
      pacing: "very_fast",
      emotion: "energetic",
      intensity: "high",
    },
  },
  {
    id: "sofia-almeida",
    name: "Sofia Almeida",
    handle: "sofia",
    pronouns: "she/her",
    institution: "Lisbon",
    tier: "breaking",
    elo: 1585,
    bio: "Extension machine. Finds the actor everyone else forgot about.",
    quirks: [
      "always characterises a specific person affected by the policy",
      "signposts as 'first, second, and the thing nobody has said yet'",
      "slight Portuguese accent, expressive",
    ],
    avatarColor: "#faa61a",
    voice: {
      model: "mulberry",
      speaker: "sophia",
      description:
        "a female 20s european voice, warm timbre, formal register, like a storyteller",
      pacing: "fast",
      emotion: "energetic",
      intensity: "med",
    },
  },
  {
    id: "daniel-osei",
    name: "Daniel Osei",
    handle: "dosei",
    pronouns: "he/him",
    institution: "Legon",
    tier: "open",
    elo: 1480,
    bio: "Reliable open speaker. Never fourth, rarely first.",
    quirks: [
      "counts arguments on his fingers audibly: 'point one, point two'",
      "repeats the motion text when he loses his thread",
    ],
    avatarColor: "#00b0f4",
    voice: {
      model: "mulberry",
      speaker: "noah",
      description:
        "a male 20s west african english voice, deep resonant timbre, formal register, like a public speaker",
      pacing: "brisk",
      emotion: "neutral",
      intensity: "med",
    },
  },
  {
    id: "hannah-berg",
    name: "Hannah Berg",
    handle: "hberg",
    pronouns: "she/her",
    institution: "Utrecht",
    tier: "open",
    elo: 1465,
    bio: "Clean structure, dry humour, allergic to unmechanised impacts.",
    quirks: [
      "says 'let us be precise about what is being claimed'",
      "flat, dry delivery that lands the jokes better",
    ],
    avatarColor: "#9b59b6",
    voice: {
      model: "mulberry",
      speaker: "emma",
      description:
        "a female 20s european english voice, even timbre, neutral register, like an analyst",
      pacing: "brisk",
      emotion: "dry",
      intensity: "med",
    },
  },
  {
    id: "yusuf-karim",
    name: "Yusuf Karim",
    handle: "yk",
    pronouns: "he/him",
    institution: "LUMS",
    tier: "open",
    elo: 1440,
    bio: "Aggressive on POIs. Will stand up six times in one speech.",
    quirks: [
      "offers POIs constantly and phrases them as gotchas",
      "leans hard on 'that is simply not how this works in practice'",
    ],
    avatarColor: "#ed4245",
    voice: {
      model: "mulberry",
      speaker: "lucas",
      description:
        "a male 20s south asian english voice, punchy timbre, formal register, like a competitive debater",
      pacing: "fast",
      emotion: "angry",
      intensity: "med",
    },
  },
  {
    id: "clara-nguyen",
    name: "Clara Nguyen",
    handle: "clara",
    pronouns: "she/her",
    institution: "Melbourne",
    tier: "proam",
    elo: 1330,
    bio: "Second semester. Good instincts, still learning to weigh.",
    quirks: [
      "states impacts without comparing them",
      "says 'obviously' when the point is not obvious",
      "trails off at the end of sentences",
    ],
    avatarColor: "#1abc9c",
    voice: {
      model: "mulberry",
      speaker: "mia",
      description:
        "a female late teens australian voice, bright timbre, casual register, like a student",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "low",
    },
  },
  {
    id: "tom-baker",
    name: "Tom Baker",
    handle: "tomb",
    pronouns: "he/him",
    institution: "Leeds",
    tier: "proam",
    elo: 1310,
    bio: "Rebuts the loudest thing said rather than the most important thing said.",
    quirks: [
      "starts every rebuttal with 'they said, but actually'",
      "loses about thirty seconds to a tangent",
    ],
    avatarColor: "#e67e22",
    voice: {
      model: "mulberry",
      speaker: "noah",
      description:
        "a male 20s northern english voice, warm timbre, casual register, like a student",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "low",
    },
  },
  {
    id: "priya-shah",
    name: "Priya Shah",
    handle: "priyas",
    pronouns: "she/her",
    institution: "Symbiosis",
    tier: "proam",
    elo: 1295,
    bio: "Great material, structure still catching up.",
    quirks: [
      "buries the best argument in the middle with no signpost",
      "speaks quickly when nervous",
    ],
    avatarColor: "#f1c40f",
    voice: {
      model: "mulberry",
      speaker: "zoya",
      description:
        "a female late teens indian english voice, light timbre, casual register, like a student",
      pacing: "brisk",
      emotion: "excited",
      intensity: "med",
    },
  },
  {
    id: "ben-cartwright",
    name: "Ben Cartwright",
    handle: "bcart",
    pronouns: "he/him",
    institution: "Warwick",
    tier: "novice",
    elo: 1180,
    bio: "Three weeks into debating. Enthusiastic. Forgets to rebut.",
    quirks: [
      "no rebuttal at all unless reminded",
      "runs out of material with two minutes left",
      "audible 'um' between points",
    ],
    avatarColor: "#95a5a6",
    voice: {
      model: "mulberry",
      speaker: "theo",
      description:
        "a male late teens english voice, thin timbre, casual register, like a nervous first-time speaker",
      pacing: "slow",
      emotion: "neutral",
      intensity: "low",
    },
  },
  {
    id: "aisha-rahman",
    name: "Aisha Rahman",
    handle: "aishar",
    pronouns: "she/her",
    institution: "Dhaka",
    tier: "novice",
    elo: 1165,
    bio: "First tournament. Reads her notes a bit too closely.",
    quirks: [
      "asserts impacts with no mechanism",
      "restates her partner's argument thinking it is new",
      "very short speech",
    ],
    avatarColor: "#7f8c8d",
    voice: {
      model: "mulberry",
      speaker: "aisha",
      description:
        "a female late teens south asian english voice, soft timbre, casual register, like a nervous first-time speaker",
      pacing: "slow",
      emotion: "neutral",
      intensity: "low",
    },
  },
  {
    id: "elena-petrova",
    name: "Elena Petrova",
    handle: "elenap",
    pronouns: "she/her",
    institution: "HSE",
    tier: "breaking",
    elo: 1600,
    bio: "Ruthless on burden analysis. Will tell you what you failed to prove.",
    quirks: [
      "explicitly states the burden each team took on",
      "cold, precise, almost clinical tone",
    ],
    avatarColor: "#34495e",
    voice: {
      model: "mulberry",
      speaker: "ava",
      description:
        "a female 20s eastern european english voice, cool clear timbre, formal register, like a clinical analyst",
      pacing: "fast",
      emotion: "dry",
      intensity: "med",
    },
  },
  {
    id: "marcus-hall",
    name: "Marcus Hall",
    handle: "mhall",
    pronouns: "he/him",
    institution: "Cape Town",
    tier: "open",
    elo: 1520,
    bio: "Big-picture weigher. Sometimes skips the mechanism to get to the impact.",
    quirks: [
      "frames everything as 'the world we live in versus the world they build'",
      "big projection, rhetorical",
    ],
    avatarColor: "#2ecc71",
    voice: {
      model: "mulberry",
      speaker: "adam",
      description:
        "a male 30s south african voice, rich projecting timbre, formal register, like a dramatic orator",
      pacing: "brisk",
      emotion: "energetic",
      intensity: "high",
    },
  },
  {
    id: "nina-lindqvist",
    name: "Nina Lindqvist",
    handle: "ninal",
    pronouns: "she/her",
    institution: "Lund",
    tier: "open",
    elo: 1495,
    bio: "Comparative weighing is her whole personality.",
    quirks: [
      "says 'compared to what' at least twice a speech",
      "calm, unhurried",
    ],
    avatarColor: "#3498db",
    voice: {
      model: "mulberry",
      speaker: "ira",
      description:
        "a female 20s scandinavian english voice, clear timbre, formal register, like a lecturer",
      pacing: "brisk",
      emotion: "neutral",
      intensity: "med",
    },
  },
  {
    id: "raj-menon",
    name: "Raj Menon",
    handle: "rajm",
    pronouns: "he/him",
    institution: "IIT Bombay",
    tier: "breaking",
    elo: 1575,
    bio: "Mechanism obsessive. Will ask how your policy is actually funded.",
    quirks: [
      "always asks who pays and who enforces",
      "rapid, technical, slightly monotone",
    ],
    avatarColor: "#e91e63",
    voice: {
      model: "mulberry",
      speaker: "lucas",
      description:
        "a male 20s indian english voice, flat precise timbre, formal register, like a technical expert",
      pacing: "very_fast",
      emotion: "neutral",
      intensity: "med",
    },
  },
];

export const JUDGES: JudgePersona[] = [
  {
    id: "judge-farhan",
    name: "Farhan Iqbal",
    handle: "farhan",
    pronouns: "he/him",
    institution: "Chief Adjudicator",
    competence: "finalist",
    bias:
      "Strict on burdens and on whether closing halves genuinely extended. Rewards comparative weighing " +
      "over volume of material. Will not credit an argument that was asserted but never mechanised.",
    avatarColor: "#f04747",
    voice: {
      model: "mulberry",
      speaker: "adam",
      description:
        "a male 30s south asian english voice, authoritative timbre, formal register, like a chairperson",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "med",
    },
  },
  {
    id: "judge-verity",
    name: "Verity Lang",
    handle: "verity",
    pronouns: "she/her",
    institution: "Deputy CA",
    competence: "breaking",
    bias:
      "Somewhat rewards style and confident delivery over dense content. Tends to credit the speaker who " +
      "sounded most in control of the room, and can under-credit a quiet but analytically superior speech.",
    avatarColor: "#faa61a",
    voice: {
      model: "mulberry",
      speaker: "emma",
      description:
        "a female 30s british voice, warm authoritative timbre, formal register, like a chairperson",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "med",
    },
  },
  {
    id: "judge-kwame",
    name: "Kwame Boateng",
    handle: "kwame",
    pronouns: "he/him",
    institution: "Panellist",
    competence: "open",
    bias:
      "Tracks opening half well but sometimes loses the closing extensions, so closing teams must signpost " +
      "their extension explicitly to get credit from him. Sympathetic to well-characterised real-world impacts.",
    avatarColor: "#3ba55c",
    voice: {
      model: "mulberry",
      speaker: "noah",
      description:
        "a male 30s west african english voice, steady friendly timbre, formal register, like a chairperson",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "med",
    },
  },
  {
    id: "judge-anita",
    name: "Anita Desai",
    handle: "anitad",
    pronouns: "she/her",
    institution: "Panellist",
    competence: "breaking",
    bias:
      "Content-first and slightly hostile to rhetoric. Rewards precise engagement and penalises teams that " +
      "restate rather than respond. Keeps a close eye on whether whips brought new material.",
    avatarColor: "#9b59b6",
    voice: {
      model: "mulberry",
      speaker: "siya",
      description:
        "a female 30s indian english voice, crisp analytical timbre, formal register, like an examiner",
      pacing: "brisk",
      emotion: "dry",
      intensity: "med",
    },
  },
  {
    id: "judge-oliver",
    name: "Oliver Grant",
    handle: "olig",
    pronouns: "he/him",
    institution: "Trainee panellist",
    competence: "proam",
    bias:
      "Newer adjudicator. Follows the loudest clash and can be swayed by the last speech he heard. " +
      "Sometimes misses subtle weighing and rewards sheer quantity of arguments.",
    avatarColor: "#95a5a6",
    voice: {
      model: "mulberry",
      speaker: "theo",
      description:
        "a male 20s english voice, tentative friendly timbre, neutral register, like a trainee",
      pacing: "conversational",
      emotion: "neutral",
      intensity: "low",
    },
  },
];

export const PERSONA_BY_ID: Record<string, Persona> = Object.fromEntries(
  DEBATERS.map((p) => [p.id, p]),
);

export const JUDGE_BY_ID: Record<string, JudgePersona> = Object.fromEntries(
  JUDGES.map((j) => [j.id, j]),
);

export const HUMAN_COLOR = "#00a8fc";
