"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Position, SkillTier } from "@/shared/types";
import { POSITION_NAMES, PROFILES, SPEAKING_ORDER, TEAM_NAMES, formatClock } from "@/shared/bp";
import { HUMAN_COLOR, JUDGE_BY_ID, PERSONA_BY_ID } from "@/shared/roster";
import { useNow, useRound } from "@/lib/useRound";
import { ChannelList, MemberList, Rail, Shell, type Channel } from "@/components/discord/Shell";
import { ChatPanel } from "@/components/discord/ChatPanel";
import { Stage } from "@/components/stage/Stage";
import { Results } from "@/components/results/Results";
import { Soundcheck } from "@/components/diagnostics/Soundcheck";

const CHANNELS: Channel[] = [
  { id: "announcements", name: "announcements", kind: "text" },
  { id: "motion-release", name: "motion-release", kind: "text" },
  { id: "team-prep", name: "team-prep", kind: "text" },
  { id: "judges-deliberation", name: "judges-deliberation", kind: "text" },
  { id: "feedback", name: "feedback", kind: "text" },
  { id: "soundcheck", name: "soundcheck", kind: "text" },
];

export default function Home() {
  const api = useRound();
  const now = useNow();
  const router = useRouter();
  const [active, setActive] = useState("announcements");
  const [seen, setSeen] = useState<Record<string, number>>({});
  const { state, messages } = api;

  // Follow the round: prep chat during prep, the stage when the debate starts.
  useEffect(() => {
    if (!state) return;
    if (state.phase === "PREP") setActive("team-prep");
    if (state.phase === "ROUND") setActive("stage");
    if (state.phase === "DELIBERATION") setActive("judges-deliberation");
    if (state.phase === "RESULTS") setActive("results");
  }, [state?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSeen((prev) => ({ ...prev, [active]: messages.filter((m) => m.channelId === active).length }));
  }, [active, messages]);

  const unread = useMemo(() => {
    const set = new Set<string>();
    for (const c of CHANNELS) {
      const count = messages.filter((m) => m.channelId === c.id).length;
      if (count > (seen[c.id] ?? 0)) set.add(c.id);
    }
    return set;
  }, [messages, seen]);

  const colors = useMemo(() => {
    const map: Record<string, string> = { human: HUMAN_COLOR };
    for (const [id, p] of Object.entries(PERSONA_BY_ID)) map[id] = p.avatarColor;
    for (const [id, j] of Object.entries(JUDGE_BY_ID)) map[id] = j.avatarColor;
    return map;
  }, []);

  const prepLeft = state?.prepEndsAt ? Math.max(0, state.prepEndsAt - now) : 0;

  return (
    <Shell>
      <Rail onCircuit={() => router.push("/circuit")} />
      <ChannelList
        channels={CHANNELS}
        active={active}
        onSelect={setActive}
        state={state}
        unread={unread}
      />

      {active === "soundcheck" ? (
        <Soundcheck api={api} />
      ) : !state ? (
        <Lobby api={api} />
      ) : active === "stage" ? (
        <Stage api={api} now={now} />
      ) : active === "results" ? (
        <Results state={state} />
      ) : (
        <ChatPanel
          channelId={active}
          channelName={CHANNELS.find((c) => c.id === active)?.name ?? active}
          messages={messages}
          onSend={(content) => api.sendChat(active, content)}
          disabled={active !== "team-prep"}
          placeholder={
            active === "team-prep"
              ? "Talk to your partner…"
              : undefined
          }
          header={
            state.phase === "PREP" && active === "team-prep" ? (
              <span
                className={`ml-auto rounded px-2 py-1 font-mono text-sm ${prepLeft < 60_000 ? "bg-bad/20 text-bad" : "bg-black/30 text-bright"}`}
              >
                prep {formatClock(prepLeft)}
              </span>
            ) : null
          }
        />
      )}

      <MemberList state={state} colors={colors} />

      {api.errors.length > 0 && (
        <div className="pointer-events-none fixed right-4 bottom-4 max-w-md space-y-2">
          {api.errors.slice(-3).map((e, i) => (
            <div key={i} className="rounded bg-bad/90 px-3 py-2 text-sm text-white shadow-lg">
              {e}
            </div>
          ))}
        </div>
      )}

      {/* Always a way out, whatever phase the round is in. */}
      {state && active !== "stage" && (
        <div className="fixed right-6 bottom-6 flex gap-2">
          {state.phase === "PREP" && (
            <button
              onClick={api.advance}
              className="rounded-full bg-brand px-5 py-3 text-sm font-medium text-white shadow-lg hover:brightness-110"
            >
              Ready — start the round
            </button>
          )}
          <button
            onClick={api.endRound}
            className="rounded-full bg-inputbg px-5 py-3 text-sm font-medium text-normal shadow-lg hover:bg-bad hover:text-white"
          >
            {state.phase === "RESULTS" ? "Back to lobby" : "Leave round"}
          </button>
        </div>
      )}
    </Shell>
  );
}

/** Permission is requested here so the browser prompt never lands mid-speech. */
function AudioCheck({ api }: { api: ReturnType<typeof useRound> }) {
  const check = api.micCheck;
  const tone =
    check?.status === "granted"
      ? check.peak < 0.02
        ? "border-warn/50 bg-warn/10"
        : "border-good/50 bg-good/10"
      : check
        ? "border-bad/50 bg-bad/10"
        : "border-line bg-black/20";

  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void api.requestAudio()}
          disabled={api.checkingMic}
          className="rounded bg-inputbg px-3 py-2 text-sm text-normal hover:bg-hover disabled:opacity-50"
        >
          {api.checkingMic
            ? "Listening…"
            : check?.status === "granted"
              ? "Test again"
              : "Enable microphone"}
        </button>
        <div className="min-w-0 flex-1 text-sm">
          {!check && (
            <span className="text-muted">
              Grant access before the round so the prompt never interrupts your speech.
            </span>
          )}
          {check?.status === "granted" && (
            <span className="text-normal">
              {check.peak < 0.02 ? "Allowed, but silent" : "Microphone working"}
              {check.deviceLabel && <span className="text-muted"> · {check.deviceLabel}</span>}
            </span>
          )}
          {check && check.status !== "granted" && <span className="text-bad">{check.message}</span>}
        </div>
      </div>
      {check?.status === "granted" && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/40">
          <div
            className={check.peak < 0.02 ? "h-full bg-warn" : "h-full bg-good"}
            style={{ width: `${Math.min(100, check.peak * 180)}%` }}
          />
        </div>
      )}
      {check?.status === "granted" && check.message && (
        <p className="mt-2 text-xs text-warn">{check.message}</p>
      )}
      <p className="mt-3 text-xs text-muted">
        The microphone is only held open while you have the floor. Use{" "}
        <span className="text-normal">#soundcheck</span> to audition voices and check the APIs.
      </p>
    </div>
  );
}

function Lobby({ api }: { api: ReturnType<typeof useRound> }) {
  const [profile, setProfile] = useState<"full" | "fast">("full");
  const [position, setPosition] = useState<Position | "random">("random");
  const [fieldLevel, setFieldLevel] = useState<SkillTier | "mixed">("mixed");
  const [levels, setLevels] = useState<Partial<Record<Position, SkillTier>>>({});
  const [perSeat, setPerSeat] = useState(false);

  return (
    <section className="flex flex-1 items-center justify-center bg-chat px-6">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-bold text-bright">Debate Room 1</h1>
        <p className="mt-2 text-muted">
          British Parliamentary. You take one seat; the other seven and the panel are AI, with names,
          voices and very different levels of competence.
        </p>

        <div className="mt-8 space-y-5">
          <div>
            <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
              Round length
            </div>
            <div className="grid gap-2">
              {(["full", "fast"] as const).map((id) => (
                <button
                  key={id}
                  onClick={() => setProfile(id)}
                  className={`rounded-lg border px-4 py-3 text-left transition-colors ${
                    profile === id
                      ? "border-brand bg-brand/10 text-bright"
                      : "border-line bg-black/20 text-normal hover:bg-hover"
                  }`}
                >
                  <div className="font-medium">{PROFILES[id].label}</div>
                  <div className="text-sm text-muted">
                    {id === "full"
                      ? "A real round. Roughly ninety minutes end to end."
                      : "Same machinery at speed — good for drilling a position or testing setup."}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
              Your position
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setPosition("random")}
                className={`rounded px-3 py-2 text-sm ${position === "random" ? "bg-brand text-white" : "bg-black/20 text-normal hover:bg-hover"}`}
              >
                Random draw
              </button>
              {SPEAKING_ORDER.map((p) => (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  title={POSITION_NAMES[p]}
                  className={`rounded px-3 py-2 text-sm ${position === p ? "bg-brand text-white" : "bg-black/20 text-normal hover:bg-hover"}`}
                >
                  {p}
                </button>
              ))}
            </div>
            {position !== "random" && (
              <p className="mt-2 text-sm text-muted">
                {POSITION_NAMES[position]} · {TEAM_NAMES[
                  SPEAKING_ORDER.includes(position) ? (["PM", "DPM"].includes(position) ? "OG" : ["LO", "DLO"].includes(position) ? "OO" : ["MG", "GW"].includes(position) ? "CG" : "CO") : "OG"
                ]}
              </p>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-3 text-[11px] font-bold tracking-wide text-muted uppercase">
              Opposition calibre
              <label className="flex items-center gap-1 normal-case">
                <input
                  type="checkbox"
                  checked={perSeat}
                  onChange={(e) => setPerSeat(e.target.checked)}
                />
                <span className="font-normal">set each seat</span>
              </label>
            </div>
            {!perSeat ? (
              <div className="flex flex-wrap gap-2">
                {(["mixed", "novice", "proam", "open", "breaking", "finalist"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setFieldLevel(t)}
                    className={`rounded px-3 py-2 text-sm ${fieldLevel === t ? "bg-brand text-white" : "bg-black/20 text-normal hover:bg-hover"}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid gap-1.5">
                {SPEAKING_ORDER.filter((p) => p !== position).map((p) => (
                  <div key={p} className="flex items-center gap-2">
                    <span className="w-10 shrink-0 font-mono text-xs text-muted">{p}</span>
                    <span className="w-44 shrink-0 truncate text-xs text-muted">
                      {POSITION_NAMES[p]}
                    </span>
                    <select
                      value={levels[p] ?? "mixed"}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          [p]: e.target.value === "mixed" ? undefined : (e.target.value as SkillTier),
                        }))
                      }
                      className="flex-1 rounded bg-inputbg px-2 py-1 text-sm text-normal outline-none"
                    >
                      {["mixed", "novice", "proam", "open", "breaking", "finalist"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              Level changes what a speaker can actually do — a novice never sets a burden or
              layers an argument; a finalist reframes the round and turns your material.
            </p>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
              Audio
            </div>
            <AudioCheck api={api} />
          </div>

          <button
            disabled={!api.connected}
            onClick={() =>
              api.startRound(profile, position, {
                fieldLevel: perSeat ? "mixed" : fieldLevel,
                levels: perSeat ? levels : undefined,
              })
            }
            className="w-full rounded-lg bg-good px-6 py-3.5 font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {api.connected ? "Draw the round" : "Connecting…"}
          </button>
          {api.micCheck?.status !== "granted" && (
            <p className="text-center text-xs text-warn">
              Without a microphone you can still watch the round, but you will have nothing to
              deliver when your turn comes.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
