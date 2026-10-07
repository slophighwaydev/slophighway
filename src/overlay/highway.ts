import { flattenNotes, type RsArrangement, type RsNote } from "../songsterr/rocksmith";
import type { HighwayView, PlaybackClock } from "./clock";

/** Rocksmith palette, indexed from the lowest string upward. */
const STRING_COLORS_LOW_TO_HIGH = [
  "#e5383b", // low E
  "#f2c230", // A
  "#2f8cff", // D
  "#f08a24", // G
  "#3cc35f", // B
  "#b45cff", // high e
  "#9aa4b2",
  "#9aa4b2",
];

const LOOK_AHEAD_SEC = 2.5;

function techniqueLabels(n: RsNote): string {
  const out: string[] = [];
  if (n.ho) out.push("H");
  if (n.po) out.push("P");
  if (n.tp) out.push("T");
  if (n.bn) out.push(`b${n.bn % 1 ? n.bn.toFixed(1) : n.bn}`);
  if (n.sl >= 0) out.push(`/${n.sl}`);
  if (n.slu >= 0) out.push(n.slu > n.f ? "/" : "\\");
  if (n.vb) out.push("~");
  if (n.tr) out.push("tr");
  if (n.pm) out.push("PM");
  if (n.hm) out.push("<>");
  if (n.hp) out.push("PH");
  if (n.ac) out.push(">");
  return out.join(" ");
}

/** Lightweight side-scrolling tab view for machines without WebGL2. */
export class Highway2D implements HighwayView {
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private clock: PlaybackClock;
  private raf = 0;
  private arrangement: RsArrangement | null = null;
  private notes: RsNote[] = [];
  private transparent: boolean;

  constructor(stage: HTMLElement, clock: PlaybackClock, transparent = false) {
    this.stage = stage;
    this.clock = clock;
    this.transparent = transparent;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "shh-canvas";
    stage.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.resize();
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setArrangement(arrangement: RsArrangement | null): void {
    this.arrangement = arrangement;
    this.notes = arrangement ? flattenNotes(arrangement) : [];
  }

  resize(): void {
    const w = this.stage.clientWidth || window.innerWidth;
    const h = this.stage.clientHeight || 280;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (!this.transparent) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(8, 12, 20, 0.92)");
      grad.addColorStop(1, "rgba(12, 20, 32, 0.96)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    const arr = this.arrangement;
    if (!arr) {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "600 14px Segoe UI, sans-serif";
      ctx.fillText("Waiting for Songsterr track data…", 20, h / 2);
      return;
    }

    const strings = Math.max(arr.strings, 1);
    const padX = 56;
    const padY = 28;
    const laneH = (h - padY * 2) / (strings - 1 || 1);
    const nowX = padX + 72;
    const pxPerSec = (w - nowX - 24) / LOOK_AHEAD_SEC;
    const laneY = (s: number) => padY + (strings - 1 - s) * laneH;

    for (let s = 0; s < strings; s++) {
      const y = laneY(s);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - 16, y);
      ctx.stroke();
      ctx.fillStyle = STRING_COLORS_LOW_TO_HIGH[s % STRING_COLORS_LOW_TO_HIGH.length];
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(padX - 18, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = "rgba(80, 220, 140, 0.95)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(nowX, padY - 10);
    ctx.lineTo(nowX, h - padY + 10);
    ctx.stroke();

    const t0 = this.clock.nowMs() / 1000;
    const t1 = t0 + LOOK_AHEAD_SEC;
    for (const n of this.notes) {
      if (n.t > t1) break;
      if (n.t + Math.max(n.sus, 0.05) < t0 - 0.2) continue;
      const y = laneY(n.s);
      const x = nowX + (n.t - t0) * pxPerSec;
      const color = STRING_COLORS_LOW_TO_HIGH[n.s % STRING_COLORS_LOW_TO_HIGH.length];
      if (n.sus > 0) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.28;
        ctx.fillRect(x, y - 4, n.sus * pxPerSec, 8);
        ctx.globalAlpha = 1;
      }
      const r = 11;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x - r, y - r, r * 2, r * 2, 4);
      ctx.fill();
      ctx.fillStyle = "#0b1020";
      ctx.font = "700 11px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.mt ? "X" : String(n.f), x, y + 0.5);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      const labels = techniqueLabels(n);
      if (labels) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = "600 9px Segoe UI, sans-serif";
        ctx.fillText(labels, x + r + 3, y - 8);
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "600 12px Segoe UI, sans-serif";
    const mm = Math.floor(t0 / 60);
    const ss = Math.floor(t0 % 60);
    const cs = Math.floor((t0 % 1) * 100);
    ctx.fillText(
      `${arr.name}  ·  ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}  ·  ${Math.round(this.clock.getSpeed() * 100)}%${this.clock.isPlaying() ? "" : "  (paused)"}`,
      padX,
      16,
    );
  }
}
