import type { RsArrangement } from "../songsterr/rocksmith";
import { tuningName } from "../songsterr/tuning";

export type SongInfo = { title: string; artist: string };

/** Song title, artist and the current track's tuning, top-right over the highway. */
export class SongInfoBox {
  private el: HTMLDivElement;
  private title: HTMLDivElement;
  private artist: HTMLDivElement;
  private tuning: HTMLDivElement;
  private song: SongInfo | null = null;
  private arrangement: RsArrangement | null = null;

  constructor(stage: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "shh-song-info";
    this.title = document.createElement("div");
    this.title.className = "shh-song-title";
    this.artist = document.createElement("div");
    this.artist.className = "shh-song-artist";
    this.tuning = document.createElement("div");
    this.tuning.className = "shh-song-tuning";
    this.el.append(this.title, this.artist, this.tuning);
    stage.appendChild(this.el);
    this.render();
  }

  setSong(song: SongInfo | null): void {
    this.song = song;
    this.render();
  }

  setArrangement(arr: RsArrangement | null): void {
    this.arrangement = arr;
    this.render();
  }

  private render(): void {
    const arr = this.arrangement;
    this.title.textContent = this.song?.title ?? "";
    this.artist.textContent = this.song?.artist ?? "";
    let tuning = "";
    if (arr) {
      tuning = tuningName(arr);
      if (arr.retunedFrom) tuning += ` (from ${arr.retunedFrom})`;
      if (arr.capo) tuning += ` · capo ${arr.capo}`;
    }
    this.tuning.textContent = tuning;
    this.el.hidden = !this.song && !arr;
  }
}

/** Track label shown over the highway; it grows briefly whenever the track changes. */
export class TrackBadge {
  private el: HTMLDivElement;
  private timer = 0;

  constructor(stage: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "shh-track-badge";
    stage.appendChild(this.el);
  }

  show(index: number, name: string, flash: boolean): void {
    this.el.textContent = index >= 0 ? `${index + 1} · ${name}` : name;
    this.el.hidden = !name;
    if (!flash) return;
    this.el.classList.remove("shh-flash");
    void this.el.offsetWidth;
    this.el.classList.add("shh-flash");
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove("shh-flash"), 1600);
  }

  clear(): void {
    this.show(-1, "", false);
  }
}

/** Small keyboard cheat sheet in the bottom-left corner of the highway. */
export function mountControlsLegend(stage: HTMLElement, extra: [key: string, action: string][] = []): void {
  const el = document.createElement("div");
  el.className = "shh-controls-legend";
  const rows: [string, string][] = [["1–9", "track"], ["Space", "play / pause"], ...extra];
  for (const [key, action] of rows) {
    const row = document.createElement("div");
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    row.append(kbd, ` ${action}`);
    el.appendChild(row);
  }
  stage.appendChild(el);
}

/** Zero-based track index for an unmodified 1–9 key press outside editable fields, else null. */
export function trackHotkey(e: KeyboardEvent): number | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) return null;
  const match = /^Digit([1-9])$/.exec(e.code) ?? /^Numpad([1-9])$/.exec(e.code);
  if (!match) return null;
  const target = e.target as HTMLElement | null;
  if (target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return null;
  return Number(match[1]) - 1;
}

export function trackLabel(index: number, name: string, noteCount: number): string {
  return `${index + 1}. ${name} (${noteCount} notes)`;
}
