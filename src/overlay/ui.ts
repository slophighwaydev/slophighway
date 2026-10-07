import { DETACHED_PORT, OPEN_DETACHED, type FromDetached, type ToDetached } from "../shared/detached";
import type { RsArrangement } from "../songsterr/rocksmith";
import { retuneToStandard } from "../songsterr/tuning";
import { PlaybackClock, type HighwayView } from "./clock";
import { Highway2D } from "./highway";
import { Highway3D, parseQuality, qualityOptions, webgl2Available, type Quality } from "./host3d";
import { mountControlsLegend, SongInfoBox, TrackBadge, trackHotkey, trackLabel, type SongInfo } from "./tracks";

export type OverlayController = {
  /** `preferredPartId` is the part Songsterr is showing; a manual pick in the overlay wins over it. */
  setArrangements: (items: RsArrangement[], preferredPartId?: number) => void;
  setSongInfo: (song: SongInfo | null) => void;
  setPlayback: (timeMs: number, playing: boolean, speed: number, source?: string) => void;
  setStatus: (text: string) => void;
  destroy: () => void;
};

type ViewMode = "3d" | "2d";
type DockMode = "bottom" | "top" | "float";
type FloatRect = { x: number; y: number; w: number; h: number };

type Prefs = {
  view: ViewMode;
  dock: DockMode;
  /** Stage height when docked at the top or bottom. */
  height: number;
  float: FloatRect;
  maximized: boolean;
  collapsed: boolean;
  transparent: boolean;
  quality: Quality;
  /** Show every track re-fretted for E standard. */
  standard: boolean;
};

const PREFS_KEY = "shh-prefs";
const MIN_HEIGHT = 120;
const MIN_FLOAT_WIDTH = 360;
const VERSION = "0.6.2";

function defaultFloat(): FloatRect {
  const w = Math.round(window.innerWidth * 0.6);
  const h = Math.round(window.innerHeight * 0.4);
  return { x: Math.round((window.innerWidth - w) / 2), y: 80, w, h };
}

function defaultPrefs(): Prefs {
  return {
    view: webgl2Available() ? "3d" : "2d",
    dock: "top",
    height: Math.round(window.innerHeight * 0.4),
    float: defaultFloat(),
    maximized: false,
    collapsed: false,
    transparent: false,
    quality: "balanced",
    standard: false,
  };
}

async function loadPrefs(): Promise<Prefs> {
  const base = defaultPrefs();
  try {
    const stored = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] as Partial<Prefs> | undefined;
    return {
      ...base,
      ...stored,
      float: { ...base.float, ...stored?.float },
      quality: parseQuality(stored?.quality),
    };
  } catch {
    return base;
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    void chrome.storage.local.set({ [PREFS_KEY]: prefs });
  } catch {
    // extension context can disappear after a reload; preferences are optional
  }
}

/** Cache of E-standard conversions so toggling or re-sending doesn't rebuild the chart. */
const retuned = new WeakMap<RsArrangement, RsArrangement>();
export function displayArrangement(arr: RsArrangement | null, standard: boolean): RsArrangement | null {
  if (!arr || !standard) return arr;
  let out = retuned.get(arr);
  if (!out) {
    out = retuneToStandard(arr);
    retuned.set(arr, out);
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function mountOverlay(): OverlayController {
  const root = document.createElement("div");
  root.id = "shh-root";
  root.innerHTML = `
    <div class="shh-panel">
      <div class="shh-toolbar">
        <div class="shh-brand">Slophighway v${VERSION}</div>
        <select class="shh-select shh-arrangement" aria-label="Arrangement" title="Switch tracks with keys 1–9"></select>
        <select class="shh-select shh-view" aria-label="View">
          <option value="3d">3D</option>
          <option value="2d">2D (light)</option>
        </select>
        <select class="shh-select shh-quality" aria-label="Quality" title="Lower quality renders fewer pixels and caps the frame rate at 60">
          ${qualityOptions()}
        </select>
        <button type="button" class="shh-btn shh-std" title="Re-fret every track for E standard tuning"></button>
        <select class="shh-select shh-dock" aria-label="Position">
          <option value="top">Dock top</option>
          <option value="bottom">Dock bottom</option>
          <option value="float">Floating</option>
        </select>
        <button type="button" class="shh-btn shh-detach" title="Open the highway in its own window (second monitor, full screen)">Detach</button>
        <button type="button" class="shh-btn shh-bg" title="Toggle the highway background"></button>
        <button type="button" class="shh-btn shh-max" title="Full screen highway">Full</button>
        <button type="button" class="shh-btn shh-collapse" title="Hide the highway">Hide</button>
        <span class="shh-sync"></span>
        <span class="shh-status"></span>
      </div>
      <div class="shh-stage"></div>
      <div class="shh-resize" title="Drag to resize"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const panel = root.querySelector(".shh-panel") as HTMLDivElement;
  const toolbar = root.querySelector(".shh-toolbar") as HTMLDivElement;
  const stage = root.querySelector(".shh-stage") as HTMLDivElement;
  const handle = root.querySelector(".shh-resize") as HTMLDivElement;
  const arrangementSelect = root.querySelector(".shh-arrangement") as HTMLSelectElement;
  const viewSelect = root.querySelector(".shh-view") as HTMLSelectElement;
  const dockSelect = root.querySelector(".shh-dock") as HTMLSelectElement;
  const qualitySelect = root.querySelector(".shh-quality") as HTMLSelectElement;
  const stdBtn = root.querySelector(".shh-std") as HTMLButtonElement;
  const detachBtn = root.querySelector(".shh-detach") as HTMLButtonElement;
  const bgBtn = root.querySelector(".shh-bg") as HTMLButtonElement;
  const maxBtn = root.querySelector(".shh-max") as HTMLButtonElement;
  const collapseBtn = root.querySelector(".shh-collapse") as HTMLButtonElement;
  const status = root.querySelector(".shh-status") as HTMLSpanElement;
  const sync = root.querySelector(".shh-sync") as HTMLSpanElement;

  if (!webgl2Available()) {
    viewSelect.querySelector('option[value="3d"]')?.setAttribute("disabled", "");
  }

  const clock = new PlaybackClock();
  const badge = new TrackBadge(stage);
  const info = new SongInfoBox(stage);
  mountControlsLegend(stage);
  let prefs = defaultPrefs();
  let view: HighwayView | null = null;
  let arrangements: RsArrangement[] = [];
  let current: RsArrangement | null = null;
  let song: SongInfo | null = null;
  let userPick: number | null = null;
  const ports = new Set<chrome.runtime.Port>();
  let lastPlayback: ToDetached | null = null;
  const detached = () => ports.size > 0;

  const sendDetached = (msg: ToDetached, only?: chrome.runtime.Port) => {
    for (const port of only ? [only] : ports) {
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(port);
      }
    }
  };

  const update = (patch: Partial<Prefs>, persist = true) => {
    prefs = { ...prefs, ...patch };
    if (persist) savePrefs(prefs);
    applyLayout();
  };

  const applyLayout = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dock = prefs.maximized ? "max" : prefs.dock;
    const collapsed = prefs.collapsed || detached();
    root.className = `shh-dock-${dock}`;
    root.classList.toggle("shh-collapsed", collapsed);
    root.classList.toggle("shh-is-detached", detached());
    root.classList.toggle("shh-transparent", prefs.transparent);
    const s = root.style;
    s.left = s.right = s.top = s.bottom = s.width = "";

    const toolbarH = toolbar.offsetHeight || 44;
    let stageH: number;
    if (dock === "max") {
      s.left = s.right = s.top = s.bottom = "0";
      stageH = vh - toolbarH;
    } else if (dock === "float") {
      const f = prefs.float;
      const w = clamp(f.w, MIN_FLOAT_WIDTH, vw);
      const h = clamp(f.h, MIN_HEIGHT, vh - toolbarH);
      const x = clamp(f.x, 0, vw - w);
      const y = clamp(f.y, 0, vh - toolbarH);
      prefs.float = { x, y, w, h };
      s.left = `${x}px`;
      s.top = `${y}px`;
      s.width = `${w}px`;
      stageH = Math.min(h, vh - y - toolbarH);
    } else {
      s.left = s.right = "0";
      if (dock === "top") s.top = "0";
      else s.bottom = "0";
      stageH = clamp(prefs.height, MIN_HEIGHT, vh - toolbarH - 40);
    }
    stage.style.height = collapsed ? "0px" : `${Math.max(0, stageH)}px`;

    dockSelect.value = prefs.dock;
    qualitySelect.value = prefs.quality;
    stdBtn.textContent = prefs.standard ? "E Std: on" : "E Std: off";
    stdBtn.classList.toggle("shh-on", prefs.standard);
    detachBtn.textContent = detached() ? "Attach" : "Detach";
    bgBtn.textContent = prefs.transparent ? "BG: clear" : "BG: solid";
    maxBtn.textContent = prefs.maximized ? "Exit full" : "Full";
    collapseBtn.textContent = prefs.collapsed ? "Show" : "Hide";
    view?.resize();
  };

  const createView = () => {
    view?.destroy();
    view = null;
    // the detached window does the rendering; keep the tab's GPU idle meanwhile
    if (detached()) return;
    try {
      view =
        prefs.view === "3d" && webgl2Available()
          ? new Highway3D(stage, clock, (text) => (status.textContent = text), prefs.transparent, prefs.quality)
          : new Highway2D(stage, clock, prefs.transparent);
    } catch (err) {
      console.error("[slophighway] view init failed", err);
      status.textContent = `view failed: ${String(err)}`;
      return;
    }
    viewSelect.value = prefs.view;
    view.setArrangement(shown());
    view.resize();
  };

  const shown = () => displayArrangement(current, prefs.standard);

  /** Pushes the displayed chart to the view, the on-stage labels and any detached window. */
  const publishCurrent = (flash: boolean) => {
    const arr = shown();
    if (current) badge.show(arrangements.indexOf(current), current.name, flash);
    else badge.clear();
    info.setArrangement(arr);
    view?.setArrangement(arr);
    sendDetached({ type: "arrangement", arrangement: arr });
  };

  const applySelection = (flash = false) => {
    const partId = Number(arrangementSelect.value);
    const next = arrangements.find((a) => a.partId === partId) ?? arrangements[0] ?? null;
    if (next === current) return;
    current = next;
    publishCurrent(flash);
  };

  const setStandard = (enabled: boolean) => {
    if (enabled === prefs.standard) return;
    update({ standard: enabled });
    publishCurrent(false);
    sendDetached({ type: "settings", standard: enabled });
  };
  stdBtn.addEventListener("click", () => setStandard(!prefs.standard));

  qualitySelect.addEventListener("change", () => {
    update({ quality: parseQuality(qualitySelect.value) });
    if (view instanceof Highway3D) view.setQuality(prefs.quality);
  });

  const pickTrack = (partId: number) => {
    if (!arrangements.some((a) => a.partId === partId)) return;
    userPick = partId;
    arrangementSelect.value = String(partId);
    applySelection(true);
  };

  const trackSummaries = (): ToDetached => ({
    type: "tracks",
    tracks: arrangements.map(({ partId, name, noteCount }) => ({ partId, name, noteCount })),
  });

  arrangementSelect.addEventListener("change", () => pickTrack(Number(arrangementSelect.value)));

  const onKeyDown = (e: KeyboardEvent) => {
    const index = trackHotkey(e);
    if (index == null || !arrangements[index]) return;
    pickTrack(arrangements[index].partId);
  };
  window.addEventListener("keydown", onKeyDown, true);
  viewSelect.addEventListener("change", () => {
    update({ view: viewSelect.value === "2d" ? "2d" : "3d" });
    createView();
  });
  dockSelect.addEventListener("change", () => {
    const dock = dockSelect.value as DockMode;
    update({ dock, maximized: false, collapsed: false });
  });
  bgBtn.addEventListener("click", () => {
    update({ transparent: !prefs.transparent });
    createView();
  });
  detachBtn.addEventListener("click", () => {
    if (detached()) {
      sendDetached({ type: "close" });
      return;
    }
    try {
      void chrome.runtime.sendMessage({ type: OPEN_DETACHED });
    } catch (err) {
      status.textContent = `detach failed: ${String(err)} (reload the page)`;
    }
  });

  const togglePlayback = () => {
    const play = document.getElementById("control-play");
    if (play) play.click();
    else status.textContent = "play button not found on this page";
  };

  const onConnect = (port: chrome.runtime.Port) => {
    if (port.name !== DETACHED_PORT) return;
    const wasDetached = detached();
    ports.add(port);
    sendDetached(trackSummaries(), port);
    sendDetached({ type: "song", song }, port);
    sendDetached({ type: "settings", standard: prefs.standard }, port);
    sendDetached({ type: "arrangement", arrangement: shown() }, port);
    if (lastPlayback) sendDetached(lastPlayback, port);
    port.onMessage.addListener((msg: FromDetached) => {
      if (msg?.type === "select") pickTrack(msg.partId);
      else if (msg?.type === "set-standard") setStandard(msg.enabled);
      else if (msg?.type === "toggle-play") togglePlayback();
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (detached()) return;
      applyLayout();
      createView();
    });
    if (!wasDetached) {
      createView();
      applyLayout();
    }
  };
  chrome.runtime.onConnect.addListener(onConnect);

  maxBtn.addEventListener("click", () => update({ maximized: !prefs.maximized, collapsed: false }));
  collapseBtn.addEventListener("click", () => update({ collapsed: !prefs.collapsed }));

  /** Pointer drag helper: `onMove` gets the offset from the press point. */
  const dragWith = (el: HTMLElement, down: PointerEvent, onMove: (dx: number, dy: number) => void) => {
    down.preventDefault();
    el.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => onMove(e.clientX - down.clientX, e.clientY - down.clientY);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      savePrefs(prefs);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  handle.addEventListener("pointerdown", (down) => {
    if (prefs.maximized || prefs.collapsed) return;
    if (prefs.dock === "float") {
      const start = { ...prefs.float, h: stage.clientHeight };
      dragWith(handle, down, (dx, dy) => update({ float: { ...start, w: start.w + dx, h: start.h + dy } }, false));
      return;
    }
    const startH = stage.clientHeight;
    const sign = prefs.dock === "top" ? 1 : -1;
    dragWith(handle, down, (_dx, dy) => update({ height: startH + sign * dy }, false));
  });

  toolbar.addEventListener("pointerdown", (down) => {
    if (prefs.dock !== "float" || prefs.maximized) return;
    if ((down.target as HTMLElement).closest("select, button")) return;
    const start = { ...prefs.float };
    dragWith(toolbar, down, (dx, dy) => update({ float: { ...start, x: start.x + dx, y: start.y + dy } }, false));
  });

  const resizeObserver = new ResizeObserver(() => view?.resize());
  resizeObserver.observe(stage);
  let toolbarH = 0;
  const toolbarObserver = new ResizeObserver(() => {
    if (toolbar.offsetHeight === toolbarH) return;
    toolbarH = toolbar.offsetHeight;
    applyLayout();
  });
  toolbarObserver.observe(toolbar);
  const onWindowResize = () => applyLayout();
  window.addEventListener("resize", onWindowResize);

  applyLayout();
  createView();
  void loadPrefs().then((loaded) => {
    const rebuild = loaded.view !== prefs.view || loaded.transparent !== prefs.transparent;
    const restandard = loaded.standard !== prefs.standard;
    const requality = loaded.quality !== prefs.quality;
    prefs = loaded;
    applyLayout();
    if (rebuild) createView();
    else if (requality && view instanceof Highway3D) view.setQuality(prefs.quality);
    if (restandard) publishCurrent(false);
  });

  panel.addEventListener("keydown", (e) => e.stopPropagation());

  return {
    setArrangements(items, preferredPartId) {
      arrangements = items
        .filter(
          (a) => a.strings > 0 && a.noteCount > 0 && !/drum|vocal|voice/i.test(`${a.instrument} ${a.name}`),
        )
        .sort((a, b) => a.partId - b.partId);

      arrangementSelect.innerHTML = "";
      arrangements.forEach((a, i) => {
        const opt = document.createElement("option");
        opt.value = String(a.partId);
        opt.textContent = trackLabel(i, a.name, a.noteCount);
        arrangementSelect.appendChild(opt);
      });
      sendDetached(trackSummaries());

      const byId = (id: number | null | undefined) =>
        id == null ? undefined : arrangements.find((a) => a.partId === id);
      const chosen =
        byId(userPick) ??
        byId(preferredPartId) ??
        byId(current?.partId) ??
        arrangements.find((a) => /guit/i.test(`${a.instrument} ${a.name}`)) ??
        arrangements[0];
      if (chosen) arrangementSelect.value = String(chosen.partId);
      applySelection();
      if (!arrangements.length) {
        current = null;
        if (!items.length) userPick = null;
        publishCurrent(false);
      }
    },
    setSongInfo(next) {
      song = next;
      info.setSong(song);
      sendDetached({ type: "song", song });
    },
    setPlayback(timeMs, playing, speed, source) {
      clock.set(timeMs, playing, speed);
      lastPlayback = { type: "playback", timeMs, playing, speed, sentAt: Date.now() };
      sendDetached(lastPlayback);
      if (source) sync.textContent = `sync:${source}`;
    },
    setStatus(text) {
      status.textContent = text;
    },
    destroy() {
      resizeObserver.disconnect();
      toolbarObserver.disconnect();
      chrome.runtime.onConnect.removeListener(onConnect);
      window.removeEventListener("keydown", onKeyDown, true);
      for (const port of ports) port.disconnect();
      ports.clear();
      window.removeEventListener("resize", onWindowResize);
      view?.destroy();
      root.remove();
    },
  };
}
