// Adjudication. Each judge forms an independent call, the panel deliberates in a
// channel you can watch, and the chair delivers an oral adjudication plus written
// feedback. Judges differ in competence and in a named bias, so a 2-1 split is a
// normal outcome rather than a bug.
import type {
  JudgeCall,
  JudgePersona,
  Position,
  RoundResult,
  RoundState,
  TeamId,
} from "../../src/shared/types.ts";
import { POSITION_NAMES, SPEAKING_ORDER, TEAM_NAMES, TEAM_OF } from "../../src/shared/bp.ts";
import { chat, chatJson } from "./llm.ts";
import { withOp } from "./trace.ts";

const SCALE = `Speaker scores use the standard scale:
  90-100 plausibly the best speech at a major international final
  85-89  outstanding: near-flawless analysis and weighing
  80-84  excellent: sophisticated material, strong engagement, a clear break-level speech
  75-79  good: well-explained arguments, direct engagement, some weighing
  70-74  competent: clear structure, arguments explained but not deeply mechanised
  65-69  average: relevant material, weakly explained, limited engagement
  60-64  weak: assertion rather than analysis, structure struggles
  55-59  poor: barely relevant or largely unexplained
  50-54  actively harmful to the team
Most speeches at a normal tournament sit between 68 and 82. Be honest and use the
whole realistic band — do not cluster everything at 75.`;

function transcriptFor(state: RoundState, judge: JudgePersona): string {
  const lines: string[] = [];
  lines.push(`MOTION: ${state.motion?.text}`);
  if (state.motion?.infoslide) lines.push(`INFO SLIDE: ${state.motion.infoslide}`);
  lines.push("");
  // The whole round in full words is well past a single request's token budget,
  // so each speech is given as its argument structure plus a bounded extract —
  // enough to judge on, and enough to quote back in feedback.
  const perSpeech = Math.floor(
    (judge.competence === "proam" || judge.competence === "novice" ? 3_500 : 6_500) /
      Math.max(1, state.speeches.length),
  );

  for (const s of state.speeches) {
    lines.push(`=== ${s.position} — ${POSITION_NAMES[s.position]} (${TEAM_NAMES[s.team]}) — ${s.speakerName} ===`);
    lines.push(`[spoke for ${Math.round(s.durationMs / 1000)}s]`);
    for (const a of s.arguments) {
      lines.push(`  • ${a.claim} — mechanism: ${a.mechanism || "(none given)"} — impact: ${a.impact}`);
    }
    lines.push(
      s.transcript
        ? s.transcript.slice(0, perSpeech) + (s.transcript.length > perSpeech ? " …" : "")
        : "(no audible speech was delivered)",
    );
    for (const p of s.pois) {
      if (p.status === "accepted") {
        lines.push(`[POI from ${p.fromName}: "${p.text}" — answered: "${p.answer ?? ""}"]`);
      } else if (p.status === "declined") {
        lines.push(`[POI offered by ${p.fromName} and declined]`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function judgeSystem(judge: JudgePersona): string {
  return [
    `You are ${judge.name} (${judge.pronouns}), adjudicating a British Parliamentary round.`,
    `Your known judging tendency: ${judge.bias}`,
    judge.competence === "proam" || judge.competence === "novice"
      ? "You are a relatively new adjudicator. You will miss some subtleties, and you should judge " +
        "honestly as the judge you are rather than as an ideal one."
      : "You are an experienced adjudicator and track the round closely.",
    "",
    "Rank all four teams first to fourth. In BP, teams are ranked on how much they contributed to their " +
      "side winning the debate. Closing teams must extend — genuinely new material — to beat their " +
      "opening. An argument that was asserted but never mechanised carries little weight. Whips who " +
      "bring new constructive material are penalised.",
    "",
    SCALE,
  ].join("\n");
}

export async function judgeRound(state: RoundState, judge: JudgePersona): Promise<JudgeCall> {
  const shape = `{
  "ranking": ["OG","OO","CG","CO"],
  "reasoning": "three to five sentences: what the round turned on, and why each team landed where it did",
  "speaks": {"PM":0,"LO":0,"DPM":0,"DLO":0,"MG":0,"MO":0,"GW":0,"OW":0}
}`;

  const call = await withOp("judge.call", { personaId: judge.id }, () =>
    chatJson<JudgeCall>(
    [
      {
        role: "system",
        content:
          judgeSystem(judge) +
          "\n\nRespond with JSON only, in this shape (ranking is ordered first to fourth):\n" +
          shape,
      },
      { role: "user", content: transcriptFor(state, judge) },
    ],
    { reasoningEffort: "medium", temperature: 0.7, maxTokens: 2500 },
  ));

  const valid: TeamId[] = ["OG", "OO", "CG", "CO"];
  const ranking = (Array.isArray(call.ranking) ? call.ranking : []).filter((t) =>
    valid.includes(t),
  ) as TeamId[];
  for (const t of valid) if (!ranking.includes(t)) ranking.push(t);

  const speaks = {} as Record<Position, number>;
  for (const pos of SPEAKING_ORDER) {
    const raw = Number(call.speaks?.[pos]);
    speaks[pos] = Number.isFinite(raw) ? Math.min(100, Math.max(50, Math.round(raw))) : 70;
  }

  return {
    judgeId: judge.id,
    judgeName: judge.name,
    ranking: ranking.slice(0, 4),
    reasoning: call.reasoning ?? "",
    speaks,
  };
}

/** Panel deliberation, rendered as a readable back-and-forth between the judges. */
export async function deliberate(
  state: RoundState,
  calls: JudgeCall[],
): Promise<Array<{ judgeId: string; content: string }>> {
  if (calls.length < 2) return [];
  const summary = calls
    .map(
      (c) =>
        `${c.judgeName}: ${c.ranking.join(" > ")} — ${c.reasoning}`,
    )
    .join("\n\n");

  const raw = await chatJson<{ turns: Array<{ judge: string; says: string }> }>(
    [
      {
        role: "system",
        content:
          "You are writing the deliberation between adjudicators after a British Parliamentary round. " +
          "The chair is listed first. Produce six to ten short turns of real deliberation: the chair " +
          "opens by naming where the panel agrees and where it splits, wings defend their calls with " +
          "specific reference to what speakers said, and the chair closes with the panel's decision. " +
          "Judges should sound like their stated tendencies. Respond with JSON: " +
          '{"turns":[{"judge":"exact name","says":"one or two sentences"}]}',
      },
      {
        role: "user",
        content: `Motion: ${state.motion?.text}\n\nThe panel's independent calls:\n\n${summary}`,
      },
    ],
    { role: "fast", reasoningEffort: "medium", temperature: 0.85, maxTokens: 2000 },
  ).catch(() => ({ turns: [] }));

  const byName = new Map(calls.map((c) => [c.judgeName.toLowerCase(), c.judgeId]));
  return (raw.turns ?? [])
    .map((t) => ({
      judgeId: byName.get((t.judge ?? "").toLowerCase().trim()) ?? calls[0].judgeId,
      content: t.says ?? "",
    }))
    .filter((t) => t.content);
}

/** Combine the panel's calls: majority ranking by average position, speaks averaged. */
export function reconcile(calls: JudgeCall[]): { ranking: TeamId[]; speaks: Record<Position, number> } {
  const teams: TeamId[] = ["OG", "OO", "CG", "CO"];
  const score = new Map<TeamId, number>(teams.map((t) => [t, 0]));
  for (const call of calls) {
    call.ranking.forEach((team, idx) => {
      score.set(team, (score.get(team) ?? 0) + idx);
    });
  }
  const ranking = [...teams].sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0));

  const speaks = {} as Record<Position, number>;
  for (const pos of SPEAKING_ORDER) {
    const values = calls.map((c) => c.speaks[pos]).filter((n) => Number.isFinite(n));
    speaks[pos] = values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : 70;
  }
  return { ranking, speaks };
}

/** The chair's spoken oral adjudication, delivered aloud after the round. */
export async function oralAdjudication(
  state: RoundState,
  chair: JudgePersona,
  ranking: TeamId[],
  calls: JudgeCall[],
): Promise<string> {
  return chat(
    [
      {
        role: "system",
        content: [
          `You are ${chair.name}, chairing the panel. Deliver the oral adjudication ALOUD.`,
          "Structure it the way chairs actually do: state the call, explain what the round came down to, " +
            "then go through the teams from first to fourth explaining the comparison between each " +
            "adjacent pair. Reference what specific speakers actually said.",
          "Spoken word only — no markdown, no headings, no bullet points. Around two hundred and fifty words.",
          calls.length > 1 && new Set(calls.map((c) => c.ranking.join())).size > 1
            ? "The panel was split; say so, and briefly note where the disagreement was."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: [
          `Motion: ${state.motion?.text}`,
          `The call, first to fourth: ${ranking.map((t) => TEAM_NAMES[t]).join(", then ")}.`,
          "",
          "The panel's reasoning:",
          calls.map((c) => `${c.judgeName}: ${c.reasoning}`).join("\n\n"),
          "",
          "Speeches:",
          state.speeches
            .map((s) => `${s.position} (${s.speakerName}): ${s.transcript.slice(0, 1200)}`)
            .join("\n\n"),
        ].join("\n"),
      },
    ],
    { reasoningEffort: "medium", temperature: 0.8, maxTokens: 1400 },
  );
}

/** Written feedback for every speaker, quoting what they actually said. */
export async function writtenFeedback(
  state: RoundState,
  chair: JudgePersona,
  ranking: TeamId[],
  speaks: Record<Position, number>,
): Promise<Record<Position, string>> {
  const humanPos = state.humanPosition;
  const result = await chatJson<Record<string, string>>(
    [
      {
        role: "system",
        content: [
          `You are ${chair.name}, writing individual feedback after a British Parliamentary round.`,
          "For each speaker give three or four sentences: what worked, the single most important thing " +
            "to fix, and one concrete instruction for next time. Quote or closely paraphrase something " +
            "they actually said — generic feedback is useless.",
          humanPos
            ? `The ${humanPos} is a human practising seriously. Give them the most detailed and most ` +
              "demanding feedback of the eight, and be specific about the flaw that cost them most."
            : "",
          'Respond with JSON keyed by position: {"PM":"...","LO":"...","DPM":"...","DLO":"...",' +
            '"MG":"...","MO":"...","GW":"...","OW":"..."}',
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: [
          `Motion: ${state.motion?.text}`,
          `Call: ${ranking.join(" > ")}`,
          `Speaks: ${SPEAKING_ORDER.map((p) => `${p} ${speaks[p]}`).join(", ")}`,
          "",
          state.speeches
            .map(
              (s) =>
                `=== ${s.position} — ${s.speakerName} (${TEAM_NAMES[s.team]}) ===\n${s.transcript.slice(0, 3000)}`,
            )
            .join("\n\n"),
        ].join("\n"),
      },
    ],
    { role: "fast", reasoningEffort: "medium", temperature: 0.75, maxTokens: 3000 },
  ).catch(() => ({}) as Record<string, string>);

  const out = {} as Record<Position, string>;
  for (const pos of SPEAKING_ORDER) out[pos] = result[pos] ?? "No feedback recorded for this speaker.";
  return out;
}

/** Standard Elo update against the field, using the team's place. */
export function eloDelta(place: number, currentElo: number, fieldAvg: number): number {
  // 1st = +1.0 score, 4th = 0. Expected score from rating difference.
  const actual = [1, 0.66, 0.33, 0][Math.min(3, Math.max(0, place - 1))];
  const expected = 1 / (1 + 10 ** ((fieldAvg - currentElo) / 400));
  const k = 32;
  return Math.round(k * (actual - expected));
}

export function placeOf(ranking: TeamId[], team: TeamId): number {
  return ranking.indexOf(team) + 1;
}

export { TEAM_OF };
