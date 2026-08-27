// Persistent circuit: Elo, results and full transcripts, in node's built-in
// SQLite (no native module to build).
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type {
  CircuitStanding,
  Position,
  RoundHistoryEntry,
  RoundState,
  TeamId,
} from "../../src/shared/types.ts";
import { DEBATERS } from "../data/personas.ts";
import { TEAM_OF } from "../../src/shared/bp.ts";

const db = new DatabaseSync(process.env.DEBSOC_DB ?? join(process.cwd(), "debsoc.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS ratings (
    persona_id  TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    elo         INTEGER NOT NULL,
    rounds      INTEGER NOT NULL DEFAULT 0,
    speaks_sum  INTEGER NOT NULL DEFAULT 0,
    firsts      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id             TEXT PRIMARY KEY,
    motion         TEXT NOT NULL,
    human_position TEXT NOT NULL,
    human_team     TEXT NOT NULL,
    place          INTEGER NOT NULL,
    speaks         INTEGER NOT NULL,
    elo_delta      INTEGER NOT NULL,
    ended_at       INTEGER NOT NULL,
    state_json     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS used_motions (
    motion_id TEXT PRIMARY KEY,
    used_at   INTEGER NOT NULL
  );
`);

// Seed ratings from the roster the first time, and for any persona added later.
{
  const insert = db.prepare(
    "INSERT OR IGNORE INTO ratings (persona_id, name, elo) VALUES (?, ?, ?)",
  );
  for (const p of DEBATERS) insert.run(p.id, p.name, p.elo);
  insert.run("human", "You", 1400);
}

export function getElo(personaId: string): number {
  const row = db.prepare("SELECT elo FROM ratings WHERE persona_id = ?").get(personaId) as
    | { elo: number }
    | undefined;
  return row?.elo ?? 1400;
}

export function applyResult(
  personaId: string,
  name: string,
  eloDelta: number,
  speaks: number,
  first: boolean,
): void {
  db.prepare(
    `INSERT INTO ratings (persona_id, name, elo, rounds, speaks_sum, firsts)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(persona_id) DO UPDATE SET
       elo        = elo + excluded.elo,
       rounds     = rounds + 1,
       speaks_sum = speaks_sum + excluded.speaks_sum,
       firsts     = firsts + excluded.firsts`,
  ).run(personaId, name, eloDelta, speaks, first ? 1 : 0);
}

export function saveRound(
  state: RoundState,
  place: number,
  speaks: number,
  eloDelta: number,
): void {
  if (!state.humanPosition || !state.motion) return;
  db.prepare(
    `INSERT OR REPLACE INTO rounds
       (id, motion, human_position, human_team, place, speaks, elo_delta, ended_at, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state.id,
    state.motion.text,
    state.humanPosition,
    TEAM_OF[state.humanPosition],
    place,
    speaks,
    eloDelta,
    Date.now(),
    JSON.stringify(state),
  );
  db.prepare("INSERT OR REPLACE INTO used_motions (motion_id, used_at) VALUES (?, ?)").run(
    state.motion.id,
    Date.now(),
  );
}

export function recentMotionIds(limit = 8): string[] {
  const rows = db
    .prepare("SELECT motion_id FROM used_motions ORDER BY used_at DESC LIMIT ?")
    .all(limit) as Array<{ motion_id: string }>;
  return rows.map((r) => r.motion_id);
}

export function standings(): CircuitStanding[] {
  const rows = db
    .prepare(
      `SELECT persona_id, name, elo, rounds, speaks_sum, firsts
       FROM ratings ORDER BY elo DESC`,
    )
    .all() as Array<{
    persona_id: string;
    name: string;
    elo: number;
    rounds: number;
    speaks_sum: number;
    firsts: number;
  }>;
  return rows.map((r) => ({
    personaId: r.persona_id,
    name: r.name,
    elo: r.elo,
    rounds: r.rounds,
    avgSpeaks: r.rounds ? Math.round((r.speaks_sum / r.rounds) * 10) / 10 : 0,
    firsts: r.firsts,
  }));
}

export function history(limit = 30): RoundHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT id, motion, human_position, human_team, place, speaks, elo_delta, ended_at
       FROM rounds ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    motion: string;
    human_position: string;
    human_team: string;
    place: number;
    speaks: number;
    elo_delta: number;
    ended_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    motion: r.motion,
    humanPosition: r.human_position as Position,
    humanTeam: r.human_team as TeamId,
    place: r.place,
    speaks: r.speaks,
    eloDelta: r.elo_delta,
    endedAt: r.ended_at,
  }));
}

export function loadRound(id: string): RoundState | null {
  const row = db.prepare("SELECT state_json FROM rounds WHERE id = ?").get(id) as
    | { state_json: string }
    | undefined;
  return row ? (JSON.parse(row.state_json) as RoundState) : null;
}

export default db;
