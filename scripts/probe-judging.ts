// Exercises the whole adjudication path — per-judge calls, deliberation, oral
// adjudication and written feedback — against a synthetic round, so it can be
// tested in about a minute instead of by sitting through a real one.
//
//   node --env-file=.env.local scripts/probe-judging.ts [panelSize]
import {
  judgeRound,
  deliberate,
  reconcile,
  oralAdjudication,
  writtenFeedback,
} from "../server/ai/judge.ts";
import { PROFILES, SPEAKING_ORDER, TEAM_OF } from "../src/shared/bp.ts";
import { JUDGES, PERSONA_BY_ID } from "../src/shared/roster.ts";
import type { RoundState, Seat, SpeechRecord } from "../src/shared/types.ts";

const ids = Object.keys(PERSONA_BY_ID);
const seats: Seat[] = SPEAKING_ORDER.map((position, i) => ({
  position,
  team: TEAM_OF[position],
  personaId: i === 1 ? "human" : ids[i],
  displayName: i === 1 ? "You" : PERSONA_BY_ID[ids[i]].name,
}));

// ~260 words per speech, matching what the round actually produces.
const body = (who: string) =>
  `Madam Speaker, ${who} rises on the motion before this house. The question this round turns on is who bears the cost of the status quo and whether the state is competent to intervene. ` +
  "Let me begin with rebuttal. The previous speaker claimed that parental controls are sufficient, but that assumes a level of technical literacy and available time that most working parents simply do not have. " +
  "My first argument is about the asymmetry of power between platforms and children. The mechanism is this: engagement-optimised feeds are designed by teams of behavioural scientists, tested continuously against millions of users, and deployed against developing brains that cannot yet model long-run consequences. " +
  "That produces compulsive use, displaced sleep, and displaced in-person socialisation, and the impact falls hardest on exactly the children who have least support at home. " +
  "My second argument is about the counterfactual. Opposition must show that the world without intervention is better, not merely that intervention is imperfect. " +
  "Even if enforcement is leaky, a legal norm shifts default behaviour, shifts platform design incentives, and gives parents something to point at. " +
  "On weighing: their harms are speculative and reversible, ours are measurable and accrue during a formative window that does not come back. " +
  "Compared to what, Madam Speaker? Compared to a decade of evidence that we have already run this experiment on a generation and did not like the result. " +
  "For those reasons I am proud to propose.";

const speeches: SpeechRecord[] = SPEAKING_ORDER.map((position, i) => ({
  position,
  team: TEAM_OF[position],
  speakerName: seats[i].displayName,
  personaId: seats[i].personaId,
  transcript: body(seats[i].displayName),
  arguments: [
    { claim: "Power asymmetry between platforms and children", mechanism: "engagement-optimised design tested at scale against developing brains", impact: "compulsive use and displaced sleep, worst for unsupported children" },
    { claim: "Legal norms shift platform incentives", mechanism: "a default rule changes design and gives parents leverage", impact: "structural change beyond individual enforcement" },
  ],
  startedAt: Date.now(),
  durationMs: 125_000,
  pois: [],
}));

const state: RoundState = {
  id: "judge-probe",
  phase: "DELIBERATION",
  profile: PROFILES.fast,
  motion: { id: "m", text: "This House would ban social media for under-16s", theme: "Technology", difficulty: "novice" },
  seats,
  humanPosition: "LO",
  speechIndex: 7,
  clock: { startedAt: null, lengthMs: 120000, graceMs: 10000, paused: false, pausedElapsedMs: 0 },
  prepEndsAt: null,
  speeches,
  standingPois: [],
  judges: JUDGES.slice(0, Number(process.argv[2] ?? 1)),
  result: null,
  ttsChars: 0,
  speakingPersonaId: null,
};

const calls = [];
for (const judge of state.judges) {
  const t = Date.now();
  const call = await judgeRound(state, judge);
  calls.push(call);
  console.log(`${judge.name}: ${call.ranking.join(" > ")} (${Date.now() - t}ms)`);
  console.log(`   speaks: ${SPEAKING_ORDER.map((p) => `${p}=${call.speaks[p]}`).join(" ")}`);
  console.log(`   ${call.reasoning.slice(0, 220)}`);
}

const { ranking, speaks } = reconcile(calls);
console.log("\nreconciled:", ranking.join(" > "));

const turns = await deliberate(state, calls);
console.log(`deliberation turns: ${turns.length}`);

const oral = await oralAdjudication(state, state.judges[0], ranking, calls);
console.log(`oral: ${oral.split(/\s+/).filter(Boolean).length} words`);
console.log(oral.slice(0, 300));

const fb = await writtenFeedback(state, state.judges[0], ranking, speaks);
console.log(`\nfeedback for LO (${fb.LO.split(/\s+/).filter(Boolean).length} words):`);
console.log(fb.LO);
