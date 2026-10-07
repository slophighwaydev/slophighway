import { DETACHED_PORT, type FromDetached, type ToDetached, type TrackSummary } from "../shared/detached";
import type { RsArrangement } from "../songsterr/rocksmith";
import { PlaybackClock, type HighwayView } from "../overlay/clock";
import { Highway2D } from "../overlay/highway";
import { Highway3D, parseQuality, qualityOptions, webgl2Available, type Quality } from "../overlay/host3d";
import { mountControlsLegend, SongInfoBox, TrackBadge, trackHotkey, trackLabel } from "../overlay/tracks";

type ViewMode = "3d" | "2d";
type DetachedPrefs = { view?: ViewMode; quality?: Quality };
const PREFS_KEY = "shh-detached-prefs";
const RECONNECT_MS = 2000;

const tabId = Number(new URLSearchParams(location.search).get("tab"));
const toolbar = document.querySelector(".shh-toolbar") as HTMLDivElement;
const stage = document.querySelector(".shh-stage") as HTMLDivElement;
const arrangementSelect = document.querySelector(".shh-arrangement") as HTMLSelectElement;
const viewSelect = document.querySelector(".shh-view") as HTMLSelectElement;
const qualitySelect = document.querySelector(".shh-quality") as HTMLSelectElement;
const stdBtn = document.querySelector(".shh-std") as HTMLButtonElement;
const fullBtn = document.querySelector(".shh-full") as HTMLButtonElement;
const status = document.querySelector(".shh-status") as HTMLSpanElement;

const clock = new PlaybackClock();
const badge = new TrackBadge(stage);
const info = new SongInfoBox(stage);
mountControlsLegend(stage, [["2× click", "full screen"]]);
let viewMode: ViewMode = webgl2Available() ? "3d" : "2d";
let quality: Quality = "balanced";
let standard = false;

qualitySelect.innerHTML = qualityOptions();

function savePrefs(): void {
  const prefs: DetachedPrefs = { view: viewMode, quality };
  void chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

function renderStandard(): void {
  stdBtn.textContent = standard ? "E Std: on" : "E Std: off";
  stdBtn.classList.toggle("shh-on", standard);
}
renderStandard();
let view: HighwayView | null = null;
let arrangement: RsArrangement | null = null;
let tracks: TrackSummary[] = [];
let port: chrome.runtime.Port | null = null;

if (!webgl2Available()) viewSelect.querySelector('option[value="3d"]')?.setAttribute("disabled", "");

function layout(): void {
  const fullscreen = !!document.fullscreenElement;
  document.body.classList.toggle("shh-fullscreen", fullscreen);
  fullBtn.textContent = fullscreen ? "Exit full screen" : "Full screen";
  stage.style.height = `${window.innerHeight - (fullscreen ? 0 : toolbar.offsetHeight)}px`;
  view?.resize();
}

function createView(): void {
  view?.destroy();
  view = null;
  try {
    view =
      viewMode === "3d" && webgl2Available()
        ? new Highway3D(stage, clock, (text) => (status.textContent = text), false, quality)
        : new Highway2D(stage, clock);
  } catch (err) {
    console.error("[slophighway] view init failed", err);
    status.textContent = `view failed: ${String(err)}`;
    return;
  }
  viewSelect.value = viewMode;
  qualitySelect.value = quality;
  view.setArrangement(arrangement);
  view.resize();
}

function renderTrackOptions(): void {
  arrangementSelect.innerHTML = "";
  tracks.forEach((t, i) => {
    const opt = document.createElement("option");
    opt.value = String(t.partId);
    opt.textContent = trackLabel(i, t.name, t.noteCount);
    arrangementSelect.appendChild(opt);
  });
  if (arrangement) arrangementSelect.value = String(arrangement.partId);
}

function send(msg: FromDetached): void {
  port?.postMessage(msg);
}

function requestTrack(partId: number): void {
  send({ type: "select", partId });
}

function onMessage(msg: ToDetached): void {
  switch (msg.type) {
    case "tracks":
      tracks = msg.tracks;
      renderTrackOptions();
      break;
    case "song":
      info.setSong(msg.song);
      break;
    case "settings":
      standard = msg.standard;
      renderStandard();
      break;
    case "arrangement": {
      const switched = !!arrangement && !!msg.arrangement && arrangement.partId !== msg.arrangement.partId;
      arrangement = msg.arrangement;
      document.title = arrangement ? `${arrangement.name} · Slophighway` : "Slophighway";
      if (arrangement) {
        arrangementSelect.value = String(arrangement.partId);
        badge.show(
          tracks.findIndex((t) => t.partId === arrangement!.partId),
          arrangement.name,
          switched,
        );
      } else {
        badge.clear();
      }
      info.setArrangement(arrangement);
      view?.setArrangement(arrangement);
      break;
    }
    case "playback": {
      const lag = msg.playing ? Math.max(0, Date.now() - msg.sentAt) * msg.speed : 0;
      clock.set(msg.timeMs + lag, msg.playing, msg.speed);
      break;
    }
    case "close":
      window.close();
      break;
  }
}

function connect(): void {
  let next: chrome.runtime.Port;
  try {
    next = chrome.tabs.connect(tabId, { name: DETACHED_PORT });
  } catch {
    setTimeout(connect, RECONNECT_MS);
    return;
  }
  port = next;
  next.onMessage.addListener((msg: ToDetached) => {
    if (msg.type === "arrangement") status.textContent = "synced with the Songsterr tab";
    onMessage(msg);
  });
  next.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === next) port = null;
    clock.set(clock.nowMs(), false, 1);
    status.textContent = "waiting for the Songsterr tab…";
    setTimeout(connect, RECONNECT_MS);
  });
}

arrangementSelect.addEventListener("change", () => requestTrack(Number(arrangementSelect.value)));

window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    // a focused toolbar button would otherwise be "clicked" by Space as well
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    if (!e.repeat) send({ type: "toggle-play" });
    return;
  }
  const index = trackHotkey(e);
  if (index == null || !tracks[index]) return;
  e.preventDefault();
  requestTrack(tracks[index].partId);
});

viewSelect.addEventListener("change", () => {
  viewMode = viewSelect.value === "2d" ? "2d" : "3d";
  savePrefs();
  createView();
});

qualitySelect.addEventListener("change", () => {
  quality = parseQuality(qualitySelect.value);
  savePrefs();
  if (view instanceof Highway3D) view.setQuality(quality);
});

stdBtn.addEventListener("click", () => send({ type: "set-standard", enabled: !standard }));

const toggleFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
};
fullBtn.addEventListener("click", toggleFullscreen);
stage.addEventListener("dblclick", toggleFullscreen);
document.addEventListener("fullscreenchange", layout);
window.addEventListener("resize", layout);
new ResizeObserver(() => view?.resize()).observe(stage);

async function boot(): Promise<void> {
  if (!Number.isFinite(tabId)) {
    status.textContent = "missing Songsterr tab id";
    return;
  }
  const stored = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] as DetachedPrefs | undefined;
  if (stored?.view === "2d" || (stored?.view === "3d" && webgl2Available())) viewMode = stored.view;
  quality = parseQuality(stored?.quality);
  layout();
  createView();
  connect();
}

void boot();
