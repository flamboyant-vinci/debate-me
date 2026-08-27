"use client";

import { useState } from "react";
import type { RoundState } from "@/shared/types";
import {
  POSITION_NAMES,
  SPEAKING_ORDER,
  TEAM_NAMES,
  formatClock,
  poiWindow,
} from "@/shared/bp";
import { PERSONA_BY_ID } from "@/shared/roster";
import { Avatar } from "../discord/Shell";
import type { RoundApi } from "@/lib/useRound";

export function Stage({ api, now }: { api: RoundApi; now: number }) {
  const { state, transcripts } = api;
  const [poiDraft, setPoiDraft] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  if (!state) return null;

  const position = SPEAKING_ORDER[state.speechIndex];
  const seat = state.seats.find((s) => s.position === position)!;
  const isHumanTurn = seat.personaId === "human";
  const started = state.clock.startedAt;
  const elapsed = started ? now - started : 0;
  const [poiOpen, poiClose] = poiWindow(state.profile);
  const overtime = elapsed > state.profile.speechMs;
  const inPoiWindow = started !== null && elapsed >= poiOpen && elapsed <= poiClose;

  const roomLog = api.messages.filter((m) => m.channelId === "announcements").slice(-8);
  const standing = state.standingPois.filter((p) => p.status === "offered");
  const againstYou = isHumanTurn ? standing.filter((p) => p.fromPersonaId !== "human") : [];
  const live = transcripts[position] ?? "";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-stage">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4 shadow-sm">
        <span className="text-base">🔊</span>
        <span className="font-semibold text-bright">Debate Room 1</span>
        <span className="ml-3 truncate text-sm text-muted">{state.motion?.text}</span>
        <button
          onClick={() => api.setMuted(!api.muted)}
          className="ml-auto rounded px-2 py-1 text-sm text-muted hover:bg-hover hover:text-bright"
          title="Mute the room"
        >
          {api.muted ? "🔇" : "🔊"}
        </button>
        <button
          onClick={() => setConfirmEnd(true)}
          className="rounded px-2 py-1 text-sm text-muted hover:bg-bad/20 hover:text-bad"
          title="Leave the round"
        >
          Leave
        </button>
      </header>

      {/* The table */}
      <div className="grid shrink-0 grid-cols-2 gap-3 p-4 xl:grid-cols-4">
        {(["OG", "OO", "CG", "CO"] as const).map((team) => (
          <div key={team} className="rounded-lg bg-black/20 p-3">
            <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
              {TEAM_NAMES[team]}
            </div>
            {state.seats
              .filter((s) => s.team === team)
              .map((s) => {
                const persona = s.personaId === "human" ? null : PERSONA_BY_ID[s.personaId];
                const speaking = s.position === position && started !== null;
                const done = state.speeches.some((sp) => sp.position === s.position);
                return (
                  <div
                    key={s.position}
                    className={`mb-1.5 flex items-center gap-2 rounded p-1.5 ${speaking ? "bg-good/15" : ""}`}
                  >
                    <Avatar
                      name={s.displayName}
                      color={s.personaId === "human" ? "#00a8fc" : (persona?.avatarColor ?? "#5865f2")}
                      size={34}
                      speaking={speaking}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-normal">
                        {s.displayName}
                        {s.personaId === "human" && (
                          <span className="ml-1 text-[10px] text-good">(you)</span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {s.position} · {persona ? persona.tier : "human"}
                      </div>
                    </div>
                    {done && <span className="text-xs text-muted">✓</span>}
                    {speaking && <span className="text-xs text-good">●</span>}
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      {/* Clock */}
      <div className="shrink-0 px-4">
        <div className="rounded-lg bg-black/20 p-4">
          <div className="mb-2 flex items-baseline gap-3">
            <span className="text-sm text-muted">
              {POSITION_NAMES[position]} — {seat.displayName}
            </span>
            <span
              className={`ml-auto font-mono text-2xl tabular-nums ${overtime ? "text-bad" : "text-bright"}`}
            >
              {formatClock(elapsed)}
            </span>
            <span className="font-mono text-sm text-muted">
              / {formatClock(state.profile.speechMs)}
            </span>
          </div>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-black/40">
            {/* Protected time is shaded; POIs are only legal between the bells. */}
            <div
              className="absolute inset-y-0 bg-warn/20"
              style={{ left: 0, width: `${(poiOpen / state.profile.speechMs) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 bg-warn/20"
              style={{
                left: `${(poiClose / state.profile.speechMs) * 100}%`,
                right: 0,
              }}
            />
            <div
              className={`absolute inset-y-0 left-0 ${overtime ? "bg-bad" : "bg-good"}`}
              style={{
                width: `${Math.min(100, (elapsed / state.profile.speechMs) * 100)}%`,
                opacity: 0.85,
              }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>protected</span>
            <span>{inPoiWindow ? "points of information open" : "no points"}</span>
            <span>protected</span>
          </div>
        </div>
      </div>

      {/* Live transcript, with the chair's calls alongside it */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
        <div className="min-w-0 flex-1 overflow-y-auto rounded-lg bg-black/10 p-4 text-[15px] leading-relaxed text-normal">
          {live ? (
            live
          ) : (
            <span className="text-muted italic">
              {isHumanTurn
                ? "Take the floor when you are ready. Your speech is transcribed as you speak."
                : "Waiting for the speaker…"}
            </span>
          )}
        </div>
        <div className="hidden w-64 shrink-0 flex-col overflow-y-auto rounded-lg bg-black/20 p-3 xl:flex">
          <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
            From the chair
          </div>
          {roomLog.length === 0 ? (
            <p className="text-xs text-muted italic">Nothing yet.</p>
          ) : (
            roomLog.map((m) => (
              <p key={m.id} className="mb-2 text-xs leading-relaxed text-muted">
                {m.content.replace(/\*\*/g, "")}
              </p>
            ))
          )}
        </div>
      </div>

      {/* POIs offered to you */}
      {againstYou.map((poi) => (
        <div key={poi.id} className="poi-card mx-4 mb-3 rounded-lg border border-warn/40 bg-warn/10 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-lg">🖐</span>
            <span className="font-medium text-bright">{poi.fromName}</span>
            <span className="text-sm text-muted">rises on a point of information</span>
          </div>
          <p className="mb-3 text-[15px] text-normal">“{poi.text}”</p>
          <div className="flex gap-2">
            <button
              onClick={() => api.respondToPoi(poi.id, true)}
              className="rounded bg-good px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            >
              Accept
            </button>
            <button
              onClick={() => api.respondToPoi(poi.id, false)}
              className="rounded bg-inputbg px-3 py-1.5 text-sm text-normal hover:bg-hover"
            >
              Wave down
            </button>
          </div>
        </div>
      ))}

      {confirmEnd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg bg-sidebar p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-bright">Leave the round?</h2>
            <p className="mt-2 text-sm text-muted">
              Everything stops immediately — speeches, audio and the clock. Nothing is recorded
              and no result is saved.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmEnd(false)}
                className="rounded bg-inputbg px-4 py-2 text-sm text-normal hover:bg-hover"
              >
                Stay
              </button>
              <button
                onClick={() => {
                  setConfirmEnd(false);
                  api.endRound();
                }}
                className="rounded bg-bad px-4 py-2 text-sm font-medium text-white hover:brightness-110"
              >
                Leave the round
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <footer className="shrink-0 border-t border-black/20 p-4">
        {isHumanTurn ? (
          <div className="flex items-center gap-3">
            {!started ? (
              <button
                onClick={() => void api.takeFloor()}
                className="rounded bg-good px-5 py-2.5 font-medium text-white hover:brightness-110"
              >
                Take the floor
              </button>
            ) : (
              <>
                <button
                  onClick={api.yieldFloor}
                  className="rounded bg-bad px-5 py-2.5 font-medium text-white hover:brightness-110"
                >
                  Sit down
                </button>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted">{api.micOn ? "🎙 live" : "mic off"}</span>
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-black/40">
                    <div
                      className="h-full bg-good transition-all duration-75"
                      style={{ width: `${Math.min(100, api.micLevel * 180)}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!poiDraft.trim()) return;
              api.offerPoi(poiDraft);
              setPoiDraft("");
            }}
          >
            <input
              value={poiDraft}
              onChange={(e) => setPoiDraft(e.target.value)}
              disabled={!inPoiWindow}
              placeholder={
                inPoiWindow
                  ? "Offer a point of information…"
                  : "Protected time — you cannot rise yet"
              }
              className="flex-1 rounded-lg bg-inputbg px-4 py-2.5 text-[15px] outline-none placeholder:text-muted disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!inPoiWindow || !poiDraft.trim()}
              className="rounded bg-brand px-4 py-2.5 font-medium text-white disabled:opacity-40"
            >
              🖐 Rise
            </button>
          </form>
        )}
      </footer>
    </section>
  );
}
