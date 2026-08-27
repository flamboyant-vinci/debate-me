"use client";

// Gapless playback of the WAV chunks the server streams. Chunks arrive in order
// over the socket and are scheduled back-to-back on the WebAudio clock, so a
// speech plays as one continuous voice rather than a series of clips.

export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private queue: Promise<void> = Promise.resolve();
  private sources = new Set<AudioBufferSourceNode>();
  private gain: GainNode | null = null;
  private _muted = false;

  /** Seconds of audio queued but not yet played. */
  bufferedSeconds = 0;
  onLevel: ((level: number) => void) | null = null;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Must be called from a user gesture before any audio can play. */
  unlock(): void {
    this.ensure();
  }

  set muted(value: boolean) {
    this._muted = value;
    if (this.gain) this.gain.gain.value = value ? 0 : 1;
  }
  get muted(): boolean {
    return this._muted;
  }

  enqueue(base64: string): void {
    // Serialise decoding so playback order matches arrival order.
    this.queue = this.queue.then(async () => {
      const ctx = this.ensure();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
      } catch {
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      const start = Math.max(ctx.currentTime + 0.02, this.nextStart);
      source.start(start);
      this.nextStart = start + buffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    });
  }

  /** Drop everything queued — used when you skip a speech. */
  stop(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.nextStart = this.ctx?.currentTime ?? 0;
    this.queue = Promise.resolve();
  }

  /** Seconds still queued ahead of the playhead. */
  lead(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.nextStart - this.ctx.currentTime);
  }
}
