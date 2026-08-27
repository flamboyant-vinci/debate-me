"use client";

import type { ReactNode } from "react";
import type { RoundState, Seat } from "@/shared/types";
import { POSITION_NAMES, TEAM_NAMES } from "@/shared/bp";

export function Avatar({
  name,
  color,
  size = 32,
  speaking = false,
}: {
  name: string;
  color: string;
  size?: number;
  speaking?: boolean;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none ${speaking ? "speaking" : ""}`}
      style={{ background: color, width: size, height: size, fontSize: size * 0.36 }}
      title={name}
    >
      {initials}
    </div>
  );
}

export interface Channel {
  id: string;
  name: string;
  kind: "text" | "voice";
}

export function Rail({ onCircuit }: { onCircuit: () => void }) {
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 bg-rail py-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-lg font-bold text-white">
        BP
      </div>
      <div className="h-px w-8 bg-line" />
      <button
        onClick={onCircuit}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-sidebar text-xl text-muted transition-all hover:rounded-2xl hover:bg-good hover:text-white"
        title="The circuit — standings and past rounds"
      >
        ⚑
      </button>
    </nav>
  );
}

export function ChannelList({
  channels,
  active,
  onSelect,
  state,
  unread,
}: {
  channels: Channel[];
  active: string;
  onSelect: (id: string) => void;
  state: RoundState | null;
  unread: Set<string>;
}) {
  const inRoom = state && ["ROUND", "DELIBERATION", "RESULTS"].includes(state.phase);
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar">
      <header className="flex h-12 items-center border-b border-black/20 px-4 font-semibold text-bright shadow-sm">
        Practice Tournament
      </header>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 pb-1 text-[11px] font-bold tracking-wide text-muted uppercase">
          Text channels
        </div>
        {channels
          .filter((c) => c.kind === "text")
          .map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[15px] transition-colors ${
                active === c.id
                  ? "bg-hover text-bright"
                  : unread.has(c.id)
                    ? "text-bright hover:bg-hover/60"
                    : "text-muted hover:bg-hover/60 hover:text-normal"
              }`}
            >
              <span className="text-lg leading-none text-muted">#</span>
              <span className="truncate">{c.name}</span>
              {unread.has(c.id) && active !== c.id && (
                <span className="ml-auto h-2 w-2 rounded-full bg-bright" />
              )}
            </button>
          ))}

        <div className="mt-4 px-2 pb-1 text-[11px] font-bold tracking-wide text-muted uppercase">
          Voice channels
        </div>
        <button
          onClick={() => onSelect("stage")}
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[15px] ${
            active === "stage" ? "bg-hover text-bright" : "text-muted hover:bg-hover/60"
          }`}
        >
          <span className="text-base leading-none">🔊</span>
          <span className="truncate">Debate Room 1</span>
          {inRoom && <span className="ml-auto h-2 w-2 rounded-full bg-good" />}
        </button>
        {inRoom && state && (
          <ul className="mt-1 ml-4 space-y-1">
            {state.seats.map((seat) => (
              <li key={seat.position} className="flex items-center gap-2 rounded px-2 py-1">
                <Avatar
                  name={seat.displayName}
                  color={colorFor(seat, state)}
                  size={22}
                  speaking={isSpeaking(seat, state)}
                />
                <span
                  className={`truncate text-sm ${isSpeaking(seat, state) ? "text-bright" : "text-muted"}`}
                >
                  {seat.displayName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

export function MemberList({ state, colors }: { state: RoundState | null; colors: Record<string, string> }) {
  if (!state) return null;
  const teams = ["OG", "OO", "CG", "CO"] as const;
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto bg-sidebar px-3 py-4 lg:flex">
      {teams.map((team) => (
        <div key={team} className="mb-5">
          <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
            {TEAM_NAMES[team]}
          </div>
          {state.seats
            .filter((s) => s.team === team)
            .map((seat) => (
              <div key={seat.position} className="mb-1 flex items-center gap-2 rounded px-1 py-1 hover:bg-hover">
                <Avatar
                  name={seat.displayName}
                  color={colors[seat.personaId] ?? "#5865f2"}
                  size={30}
                  speaking={isSpeaking(seat, state)}
                />
                <div className="min-w-0">
                  <div
                    className={`truncate text-sm font-medium ${seat.personaId === "human" ? "text-good" : "text-normal"}`}
                  >
                    {seat.displayName}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {POSITION_NAMES[seat.position]}
                  </div>
                </div>
              </div>
            ))}
        </div>
      ))}

      <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
        Adjudication
      </div>
      {state.judges.map((judge, i) => (
        <div key={judge.id} className="mb-1 flex items-center gap-2 rounded px-1 py-1 hover:bg-hover" title={judge.bias}>
          <Avatar name={judge.name} color={judge.avatarColor} size={30} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-normal">{judge.name}</div>
            <div className="truncate text-xs text-muted">{i === 0 ? "Chair" : "Panellist"}</div>
          </div>
        </div>
      ))}
    </aside>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return <div className="flex h-screen w-full overflow-hidden bg-chat">{children}</div>;
}

function isSpeaking(seat: Seat, state: RoundState): boolean {
  return state.speakingPersonaId === seat.personaId && state.clock.startedAt !== null;
}

function colorFor(seat: Seat, state: RoundState): string {
  if (seat.personaId === "human") return "#00a8fc";
  return state.judges.find((j) => j.id === seat.personaId)?.avatarColor ?? "#5865f2";
}
