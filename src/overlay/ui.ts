import type { RsArrangement } from "../songsterr/rocksmith";
import { PlaybackClock, type HighwayView } from "./clock";
import { Highway2D } from "./highway";
import { Highway3D, webgl2Available } from "./host3d";

export type OverlayController = {
  /** `preferredPartId` is the part Songsterr is showing; a manual pick in the overlay wins over it. */
  setArrangements: (items: RsArrangement[], preferredPartId?: number) => void;
  setPlayback: (timeMs: number, playing: boolean, speed: number, source?: string) => void;
  setStatus: (text: string) => void;
  destroy: () => void;
};

type ViewMode = "3d" | "2d";

type Prefs = {
  view: ViewMode;
  height: number;
  maximized: boolean;
  collapsed: boolean;
};

const PREFS_KEY = "shh-prefs";
const MIN_HEIGHT = 160;
const VERSION = "0.2.0";

function defaultPrefs(): Prefs {
  return {
    view: webgl2Available() ? "3d" : "2d",
    height: Math.round(window.innerHeight * 0.45),
    maximized: false,
    collapsed: false,
  };
}

async function loadPrefs(): Promise<Prefs> {
  const base = defaultPrefs();
  try {
    const stored = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] as Partial<Prefs> | undefined;
    return { ...base, ...stored };
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

export function mountOverlay(): OverlayController {
  const root = document.createElement("div");
  root.id = "shh-root";
  root.innerHTML = `
    <div class="shh-panel">
      <div class="shh-resize" title="Drag to resize"></div>
      <div class="shh-toolbar">
        <div class="shh-brand">Songsterr Highway v${VERSION}</div>
        <select class="shh-select shh-arrangement" aria-label="Arrangement"></select>
        <select class="shh-select shh-view" aria-label="View">
          <option value="3d">3D</option>
          <option value="2d">2D (light)</option>
        </select>
        <button type="button" class="shh-btn shh-max" title="Full screen highway">Full</button>
        <button type="button" class="shh-btn shh-collapse" title="Hide the highway">Hide</button>
        <span class="shh-sync"></span>
        <span class="shh-status"></span>
      </div>
      <div class="shh-stage"></div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const panel = root.querySelector(".shh-panel") as HTMLDivElement;
  const stage = root.querySelector(".shh-stage") as HTMLDivElement;
  const handle = root.querySelector(".shh-resize") as HTMLDivElement;
  const arrangementSelect = root.querySelector(".shh-arrangement") as HTMLSelectElement;
  const viewSelect = root.querySelector(".shh-view") as HTMLSelectElement;
  const maxBtn = root.querySelector(".shh-max") as HTMLButtonElement;
  const collapseBtn = root.querySelector(".shh-collapse") as HTMLButtonElement;
  const status = root.querySelector(".shh-status") as HTMLSpanElement;
  const sync = root.querySelector(".shh-sync") as HTMLSpanElement;

  if (!webgl2Available()) {
    viewSelect.querySelector('option[value="3d"]')?.setAttribute("disabled", "");
  }

  const clock = new PlaybackClock();
  let prefs = defaultPrefs();
  let view: HighwayView | null = null;
  let arrangements: RsArrangement[] = [];
  let current: RsArrangement | null = null;
  let userPick: number | null = null;

  const applyLayout = () => {
    const maxHeight = window.innerHeight - 40;
    const height = prefs.maximized ? window.innerHeight : Math.min(Math.max(prefs.height, MIN_HEIGHT), maxHeight);
    stage.style.height = prefs.collapsed ? "0px" : `${height - (prefs.maximized ? 44 : 0)}px`;
    root.classList.toggle("shh-maximized", prefs.maximized);
    root.classList.toggle("shh-collapsed", prefs.collapsed);
    maxBtn.textContent = prefs.maximized ? "Dock" : "Full";
    collapseBtn.textContent = prefs.collapsed ? "Show" : "Hide";
    view?.resize();
  };

  const createView = () => {
    view?.destroy();
    view = null;
    try {
      view =
        prefs.view === "3d" && webgl2Available()
          ? new Highway3D(stage, clock, (text) => (status.textContent = text))
          : new Highway2D(stage, clock);
    } catch (err) {
      console.error("[songsterr-highway] view init failed", err);
      status.textContent = `view failed: ${String(err)}`;
      return;
    }
    viewSelect.value = prefs.view;
    view.setArrangement(current);
    view.resize();
  };

  const applySelection = () => {
    const partId = Number(arrangementSelect.value);
    const next = arrangements.find((a) => a.partId === partId) ?? arrangements[0] ?? null;
    if (next === current) return;
    current = next;
    view?.setArrangement(current);
  };

  arrangementSelect.addEventListener("change", () => {
    userPick = Number(arrangementSelect.value);
    applySelection();
  });
  viewSelect.addEventListener("change", () => {
    prefs = { ...prefs, view: viewSelect.value === "2d" ? "2d" : "3d" };
    savePrefs(prefs);
    createView();
  });
  maxBtn.addEventListener("click", () => {
    prefs = { ...prefs, maximized: !prefs.maximized, collapsed: false };
    savePrefs(prefs);
    applyLayout();
  });
  collapseBtn.addEventListener("click", () => {
    prefs = { ...prefs, collapsed: !prefs.collapsed };
    savePrefs(prefs);
    applyLayout();
  });

  handle.addEventListener("pointerdown", (down) => {
    if (prefs.maximized || prefs.collapsed) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = stage.clientHeight;
    const onMove = (move: PointerEvent) => {
      prefs = { ...prefs, height: startHeight + (startY - move.clientY) };
      applyLayout();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      prefs = { ...prefs, height: stage.clientHeight };
      savePrefs(prefs);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });

  const resizeObserver = new ResizeObserver(() => view?.resize());
  resizeObserver.observe(stage);
  const onWindowResize = () => applyLayout();
  window.addEventListener("resize", onWindowResize);

  applyLayout();
  createView();
  void loadPrefs().then((loaded) => {
    const viewChanged = loaded.view !== prefs.view;
    prefs = loaded;
    applyLayout();
    if (viewChanged) createView();
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
      for (const a of arrangements) {
        const opt = document.createElement("option");
        opt.value = String(a.partId);
        opt.textContent = `${a.name} (${a.noteCount} notes)`;
        arrangementSelect.appendChild(opt);
      }

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
        view?.setArrangement(null);
      }
    },
    setPlayback(timeMs, playing, speed, source) {
      clock.set(timeMs, playing, speed);
      if (source) sync.textContent = `sync:${source}`;
    },
    setStatus(text) {
      status.textContent = text;
    },
    destroy() {
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      view?.destroy();
      root.remove();
    },
  };
}
