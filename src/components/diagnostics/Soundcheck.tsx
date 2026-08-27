"use client";

import { useEffect, useRef, useState } from "react";
import type { DiagPayload, DiagResult, RoundApi, TracePayload } from "@/lib/useRound";
import { MicRecorder } from "@/lib/audio/mic";
import { Avatar } from "../discord/Shell";

/**
 * The test channel. Everything here exercises the same code a real round uses,
 * so if a voice sounds wrong or the microphone is not being heard, you find out
 * before committing to ninety minutes.
 */
export function Soundcheck({ api }: { api: RoundApi }) {
  const [payload, setPayload] = useState<DiagPayload | null>(null);
  const [checks, setChecks] = useState<DiagResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const [line, setLine] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [speakNote, setSpeakNote] = useState("");

  const [traces, setTraces] = useState<TracePayload | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [recording, setRecording] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [micNote, setMicNote] = useState("");
  const [level, setLevel] = useState(0);
  const recorderRef = useRef<MicRecorder | null>(null);

  useEffect(() => {
    void api.diagReport().then((p) => {
      if (!p?.report) return;
      setPayload(p);
      setLine(p.sample);
      setVoiceId((v) => v || (p.voices[0]?.id ?? ""));
    });
    return () => recorderRef.current?.stop();
  }, [api]);

  // Traces are the point of this panel during a round, so they refresh on their own.
  useEffect(() => {
    let alive = true;
    const pull = () => {
      void api.diagTraces().then((t) => {
        if (alive && t?.summary) setTraces(t);
      });
    };
    pull();
    if (!autoRefresh) return () => {
      alive = false;
    };
    const id = setInterval(pull, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [api, autoRefresh]);

  const runChecks = async () => {
    setRunning(true);
    setChecks(null);
    const res = await api.diagChecks();
    setChecks(res.results ?? []);
    setRunning(false);
    void api.diagReport().then((p) => p?.report && setPayload(p));
  };

  const audition = async () => {
    setSpeaking(true);
    setSpeakNote("");
    const res = await api.diagSpeak(voiceId, line);
    setSpeaking(false);
    setSpeakNote(
      res.error
        ? res.error
        : `${Math.round((res.durationMs ?? 0) / 100) / 10}s of audio — if you heard nothing, the browser may still be blocking playback.`,
    );
  };

  /** Records one segment, then sends it down the same path a speech uses. */
  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      setLevel(0);
      return;
    }
    setHeard(null);
    setMicNote("Recording — say a sentence…");
    const rec = new MicRecorder();
    recorderRef.current = rec;
    rec.onLevel = setLevel;
    rec.onSegment = async (blob) => {
      rec.stop();
      recorderRef.current = null;
      setRecording(false);
      setLevel(0);
      setMicNote("Transcribing…");
      const res = await api.diagTranscribe(blob);
      if (res.error) {
        setMicNote(res.error);
        return;
      }
      setHeard(res.text ?? "");
      setMicNote(
        res.text
          ? `${res.ms}ms · ${Math.round((res.bytes ?? 0) / 1024)}KB`
          : "Nothing was transcribed — check the input device.",
      );
    };
    try {
      await rec.start();
      setRecording(true);
    } catch (err) {
      setMicNote(String(err).slice(0, 160));
      setRecording(false);
    }
  };

  const voice = payload?.voices.find((v) => v.id === voiceId);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4 shadow-sm">
        <span className="text-xl text-muted">#</span>
        <span className="font-semibold text-bright">soundcheck</span>
        <span className="ml-3 text-sm text-muted">
          Audition voices, test the microphone, check the APIs
        </span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Voices */}
        <Panel title="Voices">
          <p className="mb-3 text-sm text-muted">
            Every debater and judge has a fixed voice. Audition them here — this is the same
            synthesis path a speech uses, and repeats are served from cache for free.
          </p>
          <div className="flex flex-wrap gap-2">
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="min-w-56 rounded bg-inputbg px-3 py-2 text-sm text-normal outline-none"
            >
              <optgroup label="Debaters">
                {payload?.voices
                  .filter((v) => v.kind === "debater")
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.detail}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Adjudicators">
                {payload?.voices
                  .filter((v) => v.kind === "judge")
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.detail}
                    </option>
                  ))}
              </optgroup>
            </select>
            <button
              onClick={() => void audition()}
              disabled={speaking || !voiceId}
              className="rounded bg-brand px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {speaking ? "Synthesising…" : "Play"}
            </button>
            <button
              onClick={api.stopPlayback}
              className="rounded bg-inputbg px-3 py-2 text-sm text-normal hover:bg-hover"
            >
              Stop
            </button>
          </div>
          <textarea
            value={line}
            onChange={(e) => setLine(e.target.value)}
            rows={2}
            className="mt-3 w-full resize-none rounded bg-inputbg px-3 py-2 text-sm text-normal outline-none"
          />
          {voice && <p className="mt-2 text-xs text-muted">{voice.name} · {voice.detail}</p>}
          {speakNote && <p className="mt-1 text-xs text-muted">{speakNote}</p>}
        </Panel>

        {/* Microphone */}
        <Panel title="Microphone">
          <p className="mb-3 text-sm text-muted">
            Records one segment and transcribes it exactly as your speech would be. What comes
            back is what the adjudicators will read.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void toggleRecording()}
              className={`rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 ${recording ? "bg-bad" : "bg-good"}`}
            >
              {recording ? "Stop and transcribe" : "Record 6 seconds"}
            </button>
            <div className="h-2 w-40 overflow-hidden rounded-full bg-black/40">
              <div
                className="h-full bg-good transition-all duration-75"
                style={{ width: `${Math.min(100, level * 180)}%` }}
              />
            </div>
            {micNote && <span className="text-xs text-muted">{micNote}</span>}
          </div>
          {heard !== null && (
            <div className="mt-3 rounded bg-black/30 p-3 text-[15px] text-normal">
              {heard || <span className="text-muted italic">(nothing heard)</span>}
            </div>
          )}
        </Panel>

        {/* APIs */}
        <Panel title="Providers and APIs">
          <div className="mb-3 space-y-1 text-sm">
            {payload?.report.providers.length ? (
              payload.report.providers.map((p, i) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="w-20 text-muted">{i === 0 ? "primary" : "fallback"}</span>
                  <span className="font-medium text-bright">{p.id}</span>
                  <span className="font-mono text-xs text-muted">
                    {p.primary}
                    {p.fast !== p.primary && ` + ${p.fast}`}
                  </span>
                  <span className="text-xs text-muted">{p.tpm.toLocaleString()} tpm</span>
                  {p.exhaustedForMs > 0 && (
                    <span className="text-xs text-bad">
                      quota exhausted, retrying in {Math.ceil(p.exhaustedForMs / 60000)}m
                    </span>
                  )}
                </div>
              ))
            ) : (
              <span className="text-bad">No provider configured.</span>
            )}
            <div className="flex gap-2 pt-1 text-xs text-muted">
              <span>speech-to-text {payload?.report.sttConfigured ? "configured" : "missing"}</span>
              <span>·</span>
              <span>text-to-speech {payload?.report.ttsConfigured ? "configured" : "missing"}</span>
              {payload?.report.tts.chars ? (
                <>
                  <span>·</span>
                  <span>{payload.report.tts.chars.toLocaleString()} characters synthesised</span>
                </>
              ) : null}
            </div>
          </div>

          <button
            onClick={() => void runChecks()}
            disabled={running}
            className="rounded bg-inputbg px-4 py-2 text-sm text-normal hover:bg-hover disabled:opacity-50"
          >
            {running ? "Checking…" : "Run live checks"}
          </button>
          <p className="mt-2 text-xs text-muted">
            Calls each provider, synthesises a line, and transcribes it back. Spends a small
            amount of quota on purpose.
          </p>

          {checks && (
            <div className="mt-3 space-y-1">
              {checks.map((c) => (
                <div key={c.label} className="flex items-start gap-2 text-sm">
                  <span className={c.ok ? "text-good" : "text-bad"}>{c.ok ? "PASS" : "FAIL"}</span>
                  <span className="w-32 shrink-0 font-mono text-xs text-muted">{c.label}</span>
                  <span className="font-mono text-xs text-muted">{c.ms}ms</span>
                  <span className="min-w-0 flex-1 break-words text-xs text-normal">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Call traces */}
        <Panel title="Model calls">
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5 text-muted">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              live
            </label>
            <span className="text-muted">
              {traces?.summary.total ?? 0} calls · {traces?.summary.failovers ?? 0} failovers
            </span>
            <span className={traces?.langfuse ? "text-good" : "text-muted"}>
              Langfuse {traces?.langfuse ? "exporting" : "not configured"}
            </span>
          </div>

          {traces?.summary.byProvider.length ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {traces.summary.byProvider.map((r) => (
                <span
                  key={r.key}
                  className={`rounded px-2 py-1 text-xs ${r.errors || r.empty ? "bg-bad/15 text-bad" : "bg-good/15 text-good"}`}
                  title={`${r.errors} errors, ${r.empty} empty`}
                >
                  {r.key} · {r.calls} calls · {r.avgMs}ms
                  {r.errors > 0 && ` · ${r.errors} err`}
                  {r.empty > 0 && ` · ${r.empty} empty`}
                </span>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-sm text-muted">No calls yet. Start a round.</p>
          )}

          <div className="max-h-80 overflow-y-auto">
            {traces?.recent.map((e) => (
              <div
                key={e.id}
                className="flex items-start gap-2 border-b border-black/20 py-1.5 text-xs last:border-0"
                title={e.error ?? ""}
              >
                <span className="w-16 shrink-0 font-mono text-muted">
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false }).slice(3)}
                </span>
                <span
                  className={`w-12 shrink-0 ${e.status === "ok" ? "text-good" : e.status === "empty" ? "text-warn" : "text-bad"}`}
                >
                  {e.status}
                </span>
                <span className="w-28 shrink-0 truncate text-normal">{e.op}</span>
                <span className="w-24 shrink-0 truncate text-muted">{e.provider}</span>
                <span className="w-40 shrink-0 truncate font-mono text-muted">{e.model}</span>
                <span className="w-16 shrink-0 text-right font-mono text-muted">{e.latencyMs}ms</span>
                <span className="w-28 shrink-0 text-right font-mono text-muted">
                  {Math.round(e.promptChars / 1000)}k→{e.completionChars}
                </span>
                <span className="min-w-0 flex-1 truncate text-bad">
                  {e.fellBackFrom.length > 0 && `after ${e.fellBackFrom.join(", ")}`}
                  {e.error && ` ${e.error.slice(0, 60)}`}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        {/* Roster reference */}
        <Panel title="Who is on the circuit">
          <div className="grid gap-2 sm:grid-cols-2">
            {payload?.voices.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setVoiceId(v.id);
                  void api.diagSpeak(v.id, line);
                }}
                className="flex items-center gap-2 rounded p-2 text-left hover:bg-hover"
                title="Play this voice"
              >
                <Avatar name={v.name} color={v.kind === "judge" ? "#faa61a" : "#5865f2"} size={28} />
                <div className="min-w-0">
                  <div className="truncate text-sm text-normal">{v.name}</div>
                  <div className="truncate text-xs text-muted">{v.detail}</div>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-black/20 p-4">
      <h2 className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </div>
  );
}
