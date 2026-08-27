"use client";

// Microphone capture for your speech.
//
// MediaRecorder chunks produced with a timeslice are not independently decodable —
// only the first carries the container header — so Whisper cannot transcribe them
// individually. Instead we record a sequence of short, complete recordings and
// restart immediately, which keeps every segment self-contained.

const SEGMENT_MS = 6000;

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private analyser: AnalyserNode | null = null;
  private ctx: AudioContext | null = null;
  private levelRaf = 0;

  /** Called with a complete, decodable audio segment. */
  onSegment: ((blob: Blob) => void) | null = null;
  /** 0..1 input level, for the VU meter. */
  onLevel: ((level: number) => void) | null = null;

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    this.running = true;
    this.startLevelMeter();
    this.recordSegment();
  }

  private startLevelMeter(): void {
    if (!this.stream) return;
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.running || !this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      this.onLevel?.(peak);
      this.levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  private recordSegment(): void {
    if (!this.running || !this.stream) return;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    const recorder = new MediaRecorder(this.stream, { mimeType: mime });
    const parts: Blob[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    recorder.onstop = () => {
      if (parts.length) {
        const blob = new Blob(parts, { type: mime });
        // Sub-second blobs are almost always silence at a boundary.
        if (blob.size > 2000) this.onSegment?.(blob);
      }
      // Chain straight into the next segment.
      if (this.running) this.recordSegment();
    };

    recorder.start();
    this.recorder = recorder;
    this.timer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, SEGMENT_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    cancelAnimationFrame(this.levelRaf);
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.onLevel?.(0);
  }
}

export type MicPermission = "unknown" | "granted" | "denied" | "missing";

export interface MicCheck {
  status: MicPermission;
  /** Label of the device that will be used, when the browser discloses it. */
  deviceLabel?: string;
  /** Peak level seen during the check, so you can tell a dead mic from a live one. */
  peak: number;
  message?: string;
}

/**
 * Ask for the microphone up front and confirm it actually hears something.
 *
 * Requesting during the round means the browser's permission prompt lands while
 * your speech clock is already running. Doing it in the lobby also gets the
 * permission remembered for the origin, so taking the floor later is instant.
 * The stream is released immediately — the mic is only held while you speak.
 */
export async function checkMicrophone(sampleMs = 1200): Promise<MicCheck> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { status: "missing", peak: 0, message: "This browser exposes no microphone API." };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        status: "denied",
        peak: 0,
        message:
          "Microphone access was refused. Allow it in the browser's site settings, " +
          "then run the check again.",
      };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return { status: "missing", peak: 0, message: "No microphone was found." };
    }
    return { status: "denied", peak: 0, message: String(err).slice(0, 160) };
  }

  const label = stream.getAudioTracks()[0]?.label || undefined;
  let peak = 0;
  const ctx = new AudioContext();
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const until = Date.now() + sampleMs;
    while (Date.now() < until) {
      analyser.getByteTimeDomainData(data);
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await ctx.close().catch(() => undefined);
    for (const track of stream.getTracks()) track.stop();
  }

  return {
    status: "granted",
    deviceLabel: label,
    peak,
    message:
      peak < 0.02
        ? "Microphone allowed, but nothing was heard. Check the input device and that it is unmuted."
        : undefined,
  };
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
