"use client";

import type { RoundState } from "@/shared/types";
import { POSITION_NAMES, SPEAKING_ORDER, TEAM_NAMES, TEAM_OF } from "@/shared/bp";
import { PERSONA_BY_ID } from "@/shared/roster";
import { Avatar } from "../discord/Shell";

const PLACE_LABEL = ["1st", "2nd", "3rd", "4th"];
const PLACE_COLOR = ["#f0b232", "#b9bbbe", "#a8703c", "#4f545c"];

export function Results({ state }: { state: RoundState }) {
  const result = state.result;
  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center bg-chat">
        <p className="text-muted">The panel is deliberating…</p>
      </div>
    );
  }

  const humanPos = state.humanPosition!;
  const humanTeam = TEAM_OF[humanPos];
  const humanPlace = result.ranking.indexOf(humanTeam) + 1;
  const split = new Set(result.calls.map((c) => c.ranking.join())).size > 1;

  return (
    <div className="flex-1 overflow-y-auto bg-chat px-6 py-6">
      <header className="mb-6">
        <div className="text-sm text-muted">{state.motion?.text}</div>
        <h1 className="mt-1 text-2xl font-bold text-bright">The call</h1>
      </header>

      <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {result.ranking.map((team, i) => {
          const isYours = team === humanTeam;
          return (
            <div
              key={team}
              className="rounded-lg border p-4"
              style={{
                borderColor: isYours ? "#00a8fc" : "var(--border)",
                background: isYours ? "rgba(0,168,252,0.07)" : "rgba(0,0,0,0.2)",
              }}
            >
              <div className="mb-1 text-2xl font-bold" style={{ color: PLACE_COLOR[i] }}>
                {PLACE_LABEL[i]}
              </div>
              <div className="mb-3 font-medium text-bright">{TEAM_NAMES[team]}</div>
              {state.seats
                .filter((s) => s.team === team)
                .map((s) => (
                  <div key={s.position} className="flex items-center justify-between py-0.5 text-sm">
                    <span className="truncate text-normal">{s.displayName}</span>
                    <span className="ml-2 font-mono text-muted">{result.speaks[s.position]}</span>
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div className="mb-8 rounded-lg bg-black/20 p-4">
        <div className="text-sm text-muted">Your round</div>
        <div className="mt-1 text-lg text-bright">
          {PLACE_LABEL[humanPlace - 1]} as {POSITION_NAMES[humanPos]} ·{" "}
          <span className="font-mono">{result.speaks[humanPos]}</span> speaks ·{" "}
          <span className={result.humanEloDelta >= 0 ? "text-good" : "text-bad"}>
            {result.humanEloDelta >= 0 ? "+" : ""}
            {result.humanEloDelta} Elo
          </span>
        </div>
      </div>

      {result.oral && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">
            Oral adjudication — {state.judges[0].name}
            {split && <span className="ml-2 text-warn normal-case">panel split</span>}
          </h2>
          <div className="rounded-lg bg-black/20 p-4 text-[15px] leading-relaxed whitespace-pre-wrap text-normal">
            {result.oral}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">
          Individual calls
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          {result.calls.map((call) => {
            const judge = state.judges.find((j) => j.id === call.judgeId);
            return (
              <div key={call.judgeId} className="rounded-lg bg-black/20 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Avatar name={call.judgeName} color={judge?.avatarColor ?? "#5865f2"} size={28} />
                  <span className="font-medium text-bright">{call.judgeName}</span>
                </div>
                <div className="mb-2 font-mono text-sm text-muted">{call.ranking.join(" > ")}</div>
                <p className="text-sm leading-relaxed text-normal">{call.reasoning}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Feedback</h2>
        <div className="space-y-3">
          {SPEAKING_ORDER.map((pos) => {
            const seat = state.seats.find((s) => s.position === pos)!;
            const persona = seat.personaId === "human" ? null : PERSONA_BY_ID[seat.personaId];
            const isYou = seat.personaId === "human";
            return (
              <div
                key={pos}
                className="rounded-lg p-4"
                style={{
                  background: isYou ? "rgba(0,168,252,0.07)" : "rgba(0,0,0,0.2)",
                  border: isYou ? "1px solid #00a8fc" : "1px solid transparent",
                }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Avatar
                    name={seat.displayName}
                    color={isYou ? "#00a8fc" : (persona?.avatarColor ?? "#5865f2")}
                    size={28}
                  />
                  <span className="font-medium text-bright">{seat.displayName}</span>
                  <span className="text-sm text-muted">
                    {POSITION_NAMES[pos]} · {TEAM_NAMES[seat.team]}
                  </span>
                  <span className="ml-auto font-mono text-bright">{result.speaks[pos]}</span>
                </div>
                <p className="text-[15px] leading-relaxed text-normal">{result.feedback[pos]}</p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
