import type { RsArrangement } from "../songsterr/rocksmith";
import { tuningOffsets } from "../songsterr/tuning";
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
  // read by the build-time patches in scripts/build.mjs when the renderer initialises
  // eslint-disable-next-line no-var
  var __shhHighway: { transparent: boolean; antialias: boolean } | undefined;
}

export type Quality = "high" | "balanced" | "performance";

type QualitySpec = {
  /** Device pixels per CSS pixel to render at; null = the renderer's own choice (up to 2x). */
  pixelRatio: number | null;
  antialias: boolean;
  /** Frame-rate cap; 0 = every display refresh. */
  fps: number;
};

const QUALITY: Record<Quality, QualitySpec> = {
  high: { pixelRatio: null, antialias: true, fps: 0 },
  balanced: { pixelRatio: 1, antialias: true, fps: 60 },
  performance: { pixelRatio: 0.75, antialias: false, fps: 60 },
};

export const QUALITY_LABELS: Record<Quality, string> = {
  high: "Quality: high",
  balanced: "Quality: balanced",
  performance: "Quality: performance",
};

export function qualityOptions(): string {
  return (Object.keys(QUALITY_LABELS) as Quality[])
    .map((q) => `<option value="${q}">${QUALITY_LABELS[q]}</option>`)
    .join("");
}

export function parseQuality(value: unknown): Quality {
  return value === "high" || value === "performance" ? value : "balanced";
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
  private transparent: boolean;
  private quality: QualitySpec;
  private lastFrame = 0;
  private frameBudget = 0;

  constructor(
    stage: HTMLElement,
    clock: PlaybackClock,
    onStatus: (text: string) => void,
    transparent = false,
    quality: Quality = "balanced",
  ) {
    this.stage = stage;
    this.clock = clock;
    this.onStatus = onStatus;
    this.transparent = transparent;
    this.quality = QUALITY[quality];
    this.canvas = document.createElement("canvas");
    this.canvas.className = "shh-canvas shh-canvas-3d";
    stage.appendChild(this.canvas);
    this.syncCanvasSize();
  }

  setArrangement(arr: RsArrangement | null): void {
    if (!arr) {
      this.stopRenderer();
      this.bundle = null;
      return;
    }
    // The renderer re-reads notes, string count and tuning from the bundle every frame and keys its
    // caches on array identity, so swapping the data in place switches tracks without rebuilding the scene.
    if (this.renderer && this.bundle) {
      Object.assign(this.bundle, this.makeBundle(arr), { currentTime: this.bundle.currentTime });
      return;
    }
    this.bundle = this.makeBundle(arr);
    this.start();
  }

  setQuality(quality: Quality): void {
    const next = QUALITY[quality];
    const restart = next.antialias !== this.quality.antialias && !!this.renderer;
    this.quality = next;
    if (!this.bundle) return;
    this.bundle.renderScale = this.renderScale();
    if (restart) {
      this.stopRenderer();
      this.start();
    }
  }

  /** The renderer multiplies this by min(devicePixelRatio, 2). */
  private renderScale(): number {
    const { pixelRatio } = this.quality;
    if (pixelRatio == null) return 1;
    return pixelRatio / Math.min(window.devicePixelRatio || 1, 2);
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
      renderScale: this.renderScale(),
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
    globalThis.__shhHighway = { transparent: this.transparent, antialias: this.quality.antialias };
    this.renderer = factory();
    this.renderer.init(this.canvas, this.bundle);
    this.renderer.readyPromise
      ?.then(() => {
        this.ready = true;
        this.resize();
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === "superseded") return;
        console.error("[slophighway] 3D renderer failed", err);
        this.onStatus(`3D failed: ${String(err)}`);
      });
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (!this.ready || !this.renderer || !this.bundle) return;
      if (!this.dueForFrame(now)) return;
      this.bundle.currentTime = this.clock.nowMs() / 1000;
      try {
        this.renderer.draw(this.bundle);
      } catch (err) {
        console.error("[slophighway] 3D draw error", err);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Spreads draws evenly so a 144/165 Hz display renders ~60 frames a second instead of every refresh. */
  private dueForFrame(now: number): boolean {
    const { fps } = this.quality;
    const dt = Math.min(now - this.lastFrame, 250);
    this.lastFrame = now;
    if (!fps) return true;
    const interval = 1000 / fps;
    this.frameBudget += dt;
    if (this.frameBudget < interval) return false;
    this.frameBudget = Math.min(this.frameBudget - interval, interval);
    return true;
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
