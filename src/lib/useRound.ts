"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ChatMessage, Position, RoundState, SkillTier } from "@/shared/types";
import { SpeechPlayer } from "./audio/player";
import { MicRecorder, blobToBase64, checkMicrophone, type MicCheck } from "./audio/mic";

export interface RoundApi {
  connected: boolean;
  state: RoundState | null;
  messages: ChatMessage[];
  /** Live transcript of the speech in progress, keyed by position. */
  transcripts: Record<string, string>;
  errors: string[];
  micLevel: number;
  micOn: boolean;
  muted: boolean;
  /** Result of the up-front microphone check, or null if not run yet. */
  micCheck: MicCheck | null;
  checkingMic: boolean;
  /** Request microphone access and confirm it hears something. */
  requestAudio: () => Promise<MicCheck>;
  startRound: (
    profileId: "full" | "fast",
    position: Position | "random",
    opts?: { fieldLevel?: SkillTier | "mixed"; levels?: Partial<Record<Position, SkillTier>> },
  ) => void;
  sendChat: (channelId: string, content: string) => void;
  takeFloor: () => Promise<void>;
  yieldFloor: () => void;
  respondToPoi: (poiId: string, accept: boolean) => void;
  offerPoi: (text: string) => void;
  advance: () => void;
  setMuted: (m: boolean) => void;
  /** Abandon the round in progress and return to the lobby. */
  endRound: () => void;
  /** #soundcheck helpers. */
  diagReport: () => Promise<DiagPayload>;
  diagChecks: () => Promise<{ results: DiagResult[]; error?: string }>;
  diagSpeak: (voiceId: string, text?: string) => Promise<{ durationMs?: number; error?: string }>;
  diagTranscribe: (blob: Blob) => Promise<{ text?: string; ms?: number; bytes?: number; error?: string }>;
  stopPlayback: () => void;
  diagTraces: () => Promise<TracePayload>;
}

export interface TraceEntry {
  id: string;
  ts: number;
  op: string;
  provider: string;
  model: string;
  role: string;
  personaId?: string;
  position?: string;
  promptChars: number;
  promptTokensEst: number;
  completionChars: number;
  maxCompletion: number;
  latencyMs: number;
  status: "ok" | "empty" | "error";
  fellBackFrom: string[];
  error?: string;
  stream: boolean;
}

export interface TracePayload {
  recent: TraceEntry[];
  summary: {
    total: number;
    failovers: number;
    byProvider: Array<{ key: string; calls: number; errors: number; empty: number; avgMs: number }>;
    byOp: Array<{ key: string; calls: number; errors: number; empty: number; avgMs: number }>;
  };
  langfuse: boolean;
}

export interface DiagResult {
  label: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface DiagVoice {
  id: string;
  name: string;
  detail: string;
  kind: "debater" | "judge";
}

export interface DiagPayload {
  report: {
    providers: Array<{ id: string; primary: string; fast: string; tpm: number; exhaustedForMs: number }>;
    tts: { chars: number; requests: number; audioMs: number; costNanos: number };
    sttConfigured: boolean;
    ttsConfigured: boolean;
  };
  voices: DiagVoice[];
  sample: string;
}

export function useRound(): RoundApi {
  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const micRef = useRef<MicRecorder | null>(null);

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RoundState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [micCheck, setMicCheck] = useState<MicCheck | null>(null);
  const [checkingMic, setCheckingMic] = useState(false);

  useEffect(() => {
    const socket = io({ transports: ["websocket"] });
    socketRef.current = socket;
    playerRef.current = new SpeechPlayer();

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("state", (s: RoundState) => setState(s));
    socket.on("chat", (m: ChatMessage) =>
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m])),
    );
    socket.on("transcript", (p: { position: Position; text: string }) =>
      setTranscripts((prev) => ({ ...prev, [p.position]: p.text })),
    );
    socket.on("audio", (p: { wav: string }) => playerRef.current?.enqueue(p.wav));
    socket.on("error", (p: { message: string }) =>
      setErrors((prev) => [...prev.slice(-4), p.message]),
    );
    socket.on("roundEnded", () => {
      playerRef.current?.stop();
      micRef.current?.stop();
      micRef.current = null;
      setMicOn(false);
      setState(null);
      setTranscripts({});
    });

    return () => {
      socket.close();
      micRef.current?.stop();
      playerRef.current?.stop();
    };
  }, []);

  /**
   * Asked for in the lobby rather than mid-speech: the browser's permission
   * prompt must not land while the speech clock is running. This is also a user
   * gesture, so it is where the audio output context gets unlocked.
   */
  const requestAudio = useCallback(async () => {
    setCheckingMic(true);
    playerRef.current?.unlock();
    try {
      const result = await checkMicrophone();
      setMicCheck(result);
      return result;
    } finally {
      setCheckingMic(false);
    }
  }, []);

  const startRound = useCallback(
    (
      profileId: "full" | "fast",
      position: Position | "random",
      opts?: { fieldLevel?: SkillTier | "mixed"; levels?: Partial<Record<Position, SkillTier>> },
    ) => {
      playerRef.current?.unlock();
      setMessages([]);
      setTranscripts({});
      setErrors([]);
      socketRef.current?.emit("startRound", { profileId, position, ...opts });
    },
    [],
  );

  const sendChat = useCallback((channelId: string, content: string) => {
    if (!content.trim()) return;
    socketRef.current?.emit("sendChat", { channelId, content });
  }, []);

  const takeFloor = useCallback(async () => {
    playerRef.current?.unlock();
    // Permission was requested in the lobby, so this should not prompt.
    socketRef.current?.emit("beginSpeech");
    const mic = new MicRecorder();
    micRef.current = mic;
    mic.onLevel = setMicLevel;
    mic.onSegment = async (blob) => {
      socketRef.current?.emit("micChunk", { audio: await blobToBase64(blob), seq: Date.now() });
    };
    try {
      await mic.start();
      setMicOn(true);
    } catch (e) {
      setErrors((prev) => [...prev, `Microphone unavailable: ${String(e)}`]);
    }
  }, []);

  const yieldFloor = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    setMicOn(false);
    setMicLevel(0);
    // Give the last segment a moment to reach the server before the speech closes.
    setTimeout(() => socketRef.current?.emit("endSpeech"), 900);
  }, []);

  const respondToPoi = useCallback((poiId: string, accept: boolean) => {
    socketRef.current?.emit("respondToPoi", { poiId, accept });
  }, []);

  const offerPoi = useCallback((text: string) => {
    socketRef.current?.emit("offerPoi", { text });
  }, []);

  const advance = useCallback(() => socketRef.current?.emit("advance"), []);

  const endRound = useCallback(() => {
    // Silence the room immediately; the server confirms with "roundEnded".
    playerRef.current?.stop();
    micRef.current?.stop();
    micRef.current = null;
    setMicOn(false);
    setMicLevel(0);
    socketRef.current?.emit("endRound");
  }, []);

  const stopPlayback = useCallback(() => playerRef.current?.stop(), []);

  /** Socket.IO acks, wrapped so callers can await them. */
  const ask = useCallback(<T,>(event: string, payload?: unknown): Promise<T> => {
    return new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket) return resolve({} as T);
      const timer = setTimeout(() => resolve({} as T), 120_000);
      const done = (value: T) => {
        clearTimeout(timer);
        resolve(value);
      };
      if (payload === undefined) socket.emit(event, done);
      else socket.emit(event, payload, done);
    });
  }, []);

  const diagReport = useCallback(() => ask<DiagPayload>("diag:report"), [ask]);
  const diagTraces = useCallback(() => ask<TracePayload>("diag:traces"), [ask]);
  const diagChecks = useCallback(
    () => ask<{ results: DiagResult[]; error?: string }>("diag:checks"),
    [ask],
  );
  const diagSpeak = useCallback(
    (voiceId: string, text?: string) => {
      playerRef.current?.unlock();
      playerRef.current?.stop();
      return ask<{ durationMs?: number; error?: string }>("diag:speak", { voiceId, text });
    },
    [ask],
  );
  const diagTranscribe = useCallback(
    async (blob: Blob) =>
      ask<{ text?: string; ms?: number; bytes?: number; error?: string }>("diag:transcribe", {
        audio: await blobToBase64(blob),
      }),
    [ask],
  );

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (playerRef.current) playerRef.current.muted = m;
  }, []);

  return useMemo(
    () => ({
      connected,
      state,
      messages,
      transcripts,
      errors,
      micLevel,
      micOn,
      muted,
      micCheck,
      checkingMic,
      requestAudio,
      startRound,
      sendChat,
      takeFloor,
      yieldFloor,
      respondToPoi,
      offerPoi,
      advance,
      setMuted,
      endRound,
      diagReport,
      diagChecks,
      diagSpeak,
      diagTranscribe,
      stopPlayback,
      diagTraces,
    }),
    [
      connected,
      state,
      messages,
      transcripts,
      errors,
      micLevel,
      micOn,
      muted,
      micCheck,
      checkingMic,
      requestAudio,
      startRound,
      sendChat,
      takeFloor,
      yieldFloor,
      respondToPoi,
      offerPoi,
      advance,
      setMuted,
      endRound,
      diagReport,
      diagChecks,
      diagSpeak,
      diagTranscribe,
      stopPlayback,
      diagTraces,
    ],
  );
}

/** Ticking clock, so timers re-render smoothly without the server pushing state. */
export function useNow(intervalMs = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
