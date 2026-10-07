import type { RsArrangement } from "../songsterr/rocksmith";
import type { HighwayView, PlaybackClock } from "./clock";

type SlopsmithRenderer = {
  init(canvas: HTMLCanvasElement, bundle: Record<string, unknown>): void;
  draw(bundle: Record<string, unknown>): void;
  resize(w: number, h: number): void;
  destroy(): void;
  readyPromise?: Promise<void>;
};

declare global {
  interface Window {
    slopsmithViz_highway_3d?: () => SlopsmithRenderer;
  }
}

/** Standard tunings as MIDI pitches, lowest string first. */
const STANDARD_GUITAR: Record<number, number[]> = {
  6: [40, 45, 50, 55, 59, 64],
  7: [35, 40, 45, 50, 55, 59, 64],
  8: [30, 35, 40, 45, 50, 55, 59, 64],
};
const STANDARD_BASS: Record<number, number[]> = {
  4: [28, 33, 38, 43],
  5: [23, 28, 33, 38, 43],
  6: [23, 28, 33, 38, 43, 48],
};

/** Rocksmith-style tuning: semitone offset per string from standard, lowest string first. */
function tuningOffsets(arr: RsArrangement): number[] {
  const lowToHigh = [...(arr.tuning ?? [])].reverse();
  const table = /bass/i.test(arr.instrument) ? STANDARD_BASS : STANDARD_GUITAR;
  const standard = table[arr.strings];
  if (!standard || lowToHigh.length !== standard.length) return new Array(arr.strings).fill(0);
  return lowToHigh.map((midi, i) => midi - standard[i]);
}

export function webgl2Available(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export class Highway3D implements HighwayView {
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private clock: PlaybackClock;
  private renderer: SlopsmithRenderer | null = null;
  private bundle: Record<string, unknown> | null = null;
  private raf = 0;
  private ready = false;
  private onStatus: (text: string) => void;

  constructor(stage: HTMLElement, clock: PlaybackClock, onStatus: (text: string) => void) {
    this.stage = stage;
    this.clock = clock;
    this.onStatus = onStatus;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "shh-canvas shh-canvas-3d";
    stage.appendChild(this.canvas);
    this.syncCanvasSize();
  }

  setArrangement(arr: RsArrangement | null): void {
    this.stopRenderer();
    this.bundle = arr ? this.makeBundle(arr) : null;
    if (this.bundle) this.start();
  }

  private stopRenderer(): void {
    cancelAnimationFrame(this.raf);
    this.ready = false;
    try {
      this.renderer?.destroy();
    } catch {
      // renderer teardown is best-effort
    }
    this.renderer = null;
    this.stage.querySelectorAll(".h3d-wrap").forEach((el) => el.remove());
  }

  private makeBundle(arr: RsArrangement): Record<string, unknown> {
    const tuning = tuningOffsets(arr);
    return {
      currentTime: 0,
      isReady: true,
      songInfo: { title: arr.name, arrangement: arr.name, tuning, capo: arr.capo },
      notes: arr.notes,
      chords: arr.chords,
      anchors: [],
      beats: arr.beats,
      sections: arr.sections,
      chordTemplates: arr.chordTemplates,
      stringCount: arr.strings,
      tuning,
      capo: arr.capo,
      lyrics: [],
      toneChanges: [],
      toneBase: null,
      drumTab: null,
      mastery: 1,
      hasPhraseData: false,
      handShapes: [],
      inverted: false,
      lefty: false,
      renderScale: 1,
      lyricsVisible: false,
      getNoteState: () => null,
    };
  }

  private start(): void {
    const factory = window.slopsmithViz_highway_3d;
    if (typeof factory !== "function") {
      this.onStatus("3D renderer not loaded");
      return;
    }
    if (!this.bundle) return;
    this.renderer = factory();
    this.renderer.init(this.canvas, this.bundle);
    this.renderer.readyPromise
      ?.then(() => {
        this.ready = true;
        this.resize();
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "superseded") return;
        console.error("[songsterr-highway] 3D renderer failed", err);
        this.onStatus(`3D failed: ${String(err)}`);
      });
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.ready || !this.renderer || !this.bundle) return;
      this.bundle.currentTime = this.clock.nowMs() / 1000;
      try {
        this.renderer.draw(this.bundle);
      } catch (err) {
        console.error("[songsterr-highway] 3D draw error", err);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  private syncCanvasSize(): { w: number; h: number } {
    const w = Math.max(1, this.stage.clientWidth);
    const h = Math.max(1, this.stage.clientHeight);
    this.canvas.width = w;
    this.canvas.height = h;
    return { w, h };
  }

  resize(): void {
    const { w, h } = this.syncCanvasSize();
    if (this.ready) this.renderer?.resize(w, h);
  }

  destroy(): void {
    this.stopRenderer();
    this.canvas.remove();
  }
}
