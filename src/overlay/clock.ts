/** Songsterr ticks arrive every ~50 ms; extrapolate between them so motion stays smooth. */
export class PlaybackClock {
  private timeMs = 0;
  private playing = false;
  private speed = 1;
  private anchorPerf = 0;

  set(timeMs: number, playing: boolean, speed: number): void {
    this.timeMs = timeMs;
    this.playing = playing;
    this.speed = speed || 1;
    this.anchorPerf = performance.now();
  }

  nowMs(): number {
    if (!this.playing) return this.timeMs;
    const elapsed = Math.min(performance.now() - this.anchorPerf, 250);
    return this.timeMs + elapsed * this.speed;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getSpeed(): number {
    return this.speed;
  }
}

export interface HighwayView {
  setArrangement(arrangement: import("../songsterr/rocksmith").RsArrangement | null): void;
  /** Call after the stage changes size. */
  resize(): void;
  destroy(): void;
}
