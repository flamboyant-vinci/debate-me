"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CircuitStanding, RoundHistoryEntry } from "@/shared/types";
import { POSITION_NAMES, TEAM_NAMES } from "@/shared/bp";
import { PERSONA_BY_ID } from "@/shared/roster";
import { Avatar } from "@/components/discord/Shell";

const PLACE = ["1st", "2nd", "3rd", "4th"];

export default function Circuit() {
  const [standings, setStandings] = useState<CircuitStanding[]>([]);
  const [history, setHistory] = useState<RoundHistoryEntry[]>([]);

  useEffect(() => {
    void fetch("/api/circuit")
      .then((r) => r.json())
      .then((d) => {
        setStandings(d.standings ?? []);
        setHistory(d.history ?? []);
      });
  }, []);

  const you = standings.find((s) => s.personaId === "human");

  return (
    <main className="min-h-screen bg-chat px-6 py-8">
      <div className="mx-auto max-w-5xl">
        <Link href="/" className="text-sm text-muted hover:text-bright">
          ← back to the server
        </Link>
        <h1 className="mt-2 text-3xl font-bold text-bright">The circuit</h1>
        <p className="mt-1 text-muted">
          Elo and speaker averages carry across rounds. The AI debaters improve or slide with their
          results, same as you.
        </p>

        {you && (
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            <Stat label="Your Elo" value={String(you.elo)} />
            <Stat label="Rounds" value={String(you.rounds)} />
            <Stat label="Average speaks" value={you.avgSpeaks ? you.avgSpeaks.toFixed(1) : "—"} />
            <Stat label="Firsts" value={String(you.firsts)} />
          </div>
        )}

        <section className="mt-10">
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Standings</h2>
          <div className="overflow-hidden rounded-lg bg-black/20">
            {standings.map((s, i) => {
              const persona = PERSONA_BY_ID[s.personaId];
              const isYou = s.personaId === "human";
              return (
                <div
                  key={s.personaId}
                  className={`flex items-center gap-3 border-b border-black/20 px-4 py-2.5 last:border-0 ${isYou ? "bg-brand/10" : ""}`}
                >
                  <span className="w-6 text-right font-mono text-sm text-muted">{i + 1}</span>
                  <Avatar
                    name={s.name}
                    color={isYou ? "#00a8fc" : (persona?.avatarColor ?? "#5865f2")}
                    size={30}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-normal">{s.name}</div>
                    <div className="truncate text-xs text-muted">
                      {persona ? `${persona.institution} · ${persona.tier}` : "you"}
                    </div>
                  </div>
                  <span className="w-16 text-right font-mono text-sm text-muted">
                    {s.rounds} rds
                  </span>
                  <span className="w-16 text-right font-mono text-sm text-muted">
                    {s.avgSpeaks || "—"}
                  </span>
                  <span className="w-16 text-right font-mono font-medium text-bright">{s.elo}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-10 mb-16">
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Your rounds</h2>
          {history.length === 0 ? (
            <p className="text-muted">No rounds yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg bg-black/20">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center gap-4 border-b border-black/20 px-4 py-3 last:border-0"
                >
                  <span
                    className={`w-10 font-mono text-sm ${h.place === 1 ? "text-warn" : "text-muted"}`}
                  >
                    {PLACE[h.place - 1]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-normal">{h.motion}</div>
                    <div className="text-xs text-muted">
                      {POSITION_NAMES[h.humanPosition]} · {TEAM_NAMES[h.humanTeam]} ·{" "}
                      {new Date(h.endedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span className="font-mono text-sm text-muted">{h.speaks}</span>
                  <span
                    className={`w-14 text-right font-mono text-sm ${h.eloDelta >= 0 ? "text-good" : "text-bad"}`}
                  >
                    {h.eloDelta >= 0 ? "+" : ""}
                    {h.eloDelta}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/20 p-4">
      <div className="text-xs tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-1 text-2xl font-bold text-bright">{value}</div>
    </div>
  );
}
