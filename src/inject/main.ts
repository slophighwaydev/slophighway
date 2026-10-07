import {
  clearTrackStash,
  CMD_CHANNEL,
  postToBridge,
  writeTrackStash,
  type BridgeMessage,
  type PlayerTickMessage,
  type SongMetaMessage,
  type SongTimingMessage,
  type TrackJsonMessage,
} from "../shared/messages";
import { parseMeta, type RawMetaCurrent } from "../songsterr/state";
import type { SongTiming } from "../songsterr/types";

const TRACK_JSON_RE =
  /https?:\/\/[^/]*cloudfront\.net\/(\d+)\/(\d+)\/([^/]+)\/(\d+)\.json/;

/** Content script often boots after the early track fetches, so keep them for replay. */
const trackCache = new Map<number, TrackJsonMessage>();

function parseTrackUrl(url: string) {
  const m = url.match(TRACK_JSON_RE);
  if (!m) return null;
  return {
    songId: Number(m[1]),
    revisionId: Number(m[2]),
    image: m[3],
    partId: Number(m[4]),
  };
}

function publishTrack(msg: TrackJsonMessage): void {
  if (currentSongId != null && msg.songId !== currentSongId) return;
  trackCache.set(msg.partId, msg);
  writeTrackStash(msg.partId, msg.data);
  postToBridge(msg);
}

function hookFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    try {
      const url =
        typeof args[0] === "string"
          ? args[0]
          : args[0] instanceof Request
            ? args[0].url
            : String(args[0]);
      const parsed = parseTrackUrl(url);
      if (parsed && response.ok) {
        response
          .clone()
          .json()
          .then((data) => publishTrack({ type: "track-json", url, ...parsed, data }))
          .catch(() => undefined);
      }
    } catch {
      // never break the page's own fetches
    }
    return response;
  };
}

function backfillTrackJson(): void {
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  for (const entry of entries) {
    const parsed = parseTrackUrl(entry.name);
    if (!parsed || trackCache.has(parsed.partId)) continue;
    if (currentSongId != null && parsed.songId !== currentSongId) continue;
    fetch(entry.name)
      .then((r) => r.json())
      .then((data) => publishTrack({ type: "track-json", url: entry.name, ...parsed, data }))
      .catch(() => undefined);
  }
}

// --- Playback clock -------------------------------------------------------
//
// Songsterr's app store hangs off the Preact tree (a vnode whose props carry
// `store.state`). Its `player.instance.getPosition().cursor` is the live song
// position in tab milliseconds — the same timeline we build from the track
// JSON — for both Synth and original-audio modes.

type SongsterrPlayerInstance = {
  isPlaying?: boolean;
  getPosition?: () => { cursor?: number };
};

type ProcessedBeat = { startTick?: number; durationInTicks?: number };
type ProcessedPart = {
  songId?: number;
  revisionId?: number;
  partId?: number;
  tpqn?: number;
  progression?: number[];
  timestamps?: number[];
  measures?: Array<{ totalTicks?: number; voices?: Array<{ beats?: ProcessedBeat[] }> }>;
};

type SongsterrStore = {
  state: {
    player?: { instance?: SongsterrPlayerInstance | null; speed?: number };
    cursor?: { position?: { cursor?: number } };
    part?: { current?: ProcessedPart | null };
    meta?: { current?: RawMetaCurrent | null };
  };
};

type PreactVNode = {
  props?: { store?: SongsterrStore };
  __k?: Array<PreactVNode | null> | null;
};

let store: SongsterrStore | null = null;
let lastStoreSearch = 0;

function findStore(): SongsterrStore | null {
  const root = document.getElementById("root") as (HTMLElement & { __k?: PreactVNode }) | null;
  if (!root?.__k) return null;

  const seen = new Set<PreactVNode>();
  const stack: PreactVNode[] = [root.__k];
  while (stack.length) {
    const vn = stack.pop();
    if (!vn || typeof vn !== "object" || seen.has(vn)) continue;
    seen.add(vn);
    if (vn.props?.store?.state) return vn.props.store;
    if (Array.isArray(vn.__k)) {
      for (const kid of vn.__k) if (kid) stack.push(kid);
    }
  }
  return null;
}

function getStore(): SongsterrStore | null {
  if (store?.state) return store;
  const now = performance.now();
  if (now - lastStoreSearch < 1000) return null;
  lastStoreSearch = now;
  store = findStore();
  if (store) postToBridge({ type: "debug", message: "found Songsterr store" });
  return store;
}

function playButtonPressed(): boolean {
  return document.getElementById("control-play")?.getAttribute("aria-pressed") === "true";
}

function readSpeedFromDom(): number {
  for (const btn of document.querySelectorAll("button")) {
    const m = (btn.textContent || "").trim().match(/^(\d{2,3})%$/);
    if (m) {
      const pct = Number(m[1]);
      if (pct >= 25 && pct <= 200) return pct / 100;
    }
  }
  return 1;
}

// Fallback clock when the store can't be reached: free-runs while Play is pressed.
let fallbackMs = 0;
let fallbackPerf: number | null = null;

function fallbackTick(speed: number): PlayerTickMessage {
  const playing = playButtonPressed();
  const now = performance.now();
  if (playing) {
    if (fallbackPerf != null) fallbackMs += (now - fallbackPerf) * speed;
    fallbackPerf = now;
  } else {
    fallbackPerf = null;
  }
  return { type: "player-tick", timeMs: fallbackMs, playing, speed, source: "estimate" };
}

function tick(): void {
  const s = getStore();
  const speedPct = s?.state.player?.speed;
  const speed = typeof speedPct === "number" && speedPct > 0 ? speedPct / 100 : readSpeedFromDom();

  const inst = s?.state.player?.instance;
  const pos = typeof inst?.getPosition === "function" ? inst.getPosition()?.cursor : undefined;

  if (typeof pos === "number" && Number.isFinite(pos)) {
    fallbackMs = pos;
    postToBridge({
      type: "player-tick",
      timeMs: pos,
      playing: inst?.isPlaying === true || playButtonPressed(),
      speed,
      source: "songsterr",
    });
    return;
  }

  const stateCursor = s?.state.cursor?.position?.cursor;
  if (!playButtonPressed() && typeof stateCursor === "number") fallbackMs = stateCursor;
  postToBridge(fallbackTick(speed));
}

// --- Song timing ----------------------------------------------------------
//
// Songsterr's processed part carries the playback order (`progression`, repeats
// expanded) and one timestamp per voice-0 beat in that order. The tempo map is
// song-wide, so these anchors place beats of every track on the player clock.

let timingMessage: SongTimingMessage | null = null;
let timingKey = "";

/** Grace notes before the downbeat have negative ticks, so the measure starts at tick 0, not at the first beat. */
function msAtTickZero(flat: number[]): number {
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i] < 0) continue;
    if (flat[i] === 0 || i === 0) return flat[i + 1];
    const t0 = flat[i - 2];
    const ms0 = flat[i - 1];
    return ms0 + ((0 - t0) * (flat[i + 1] - ms0)) / (flat[i] - t0);
  }
  return flat[1];
}

function extractTiming(part: ProcessedPart): SongTiming | null {
  const { progression, timestamps, measures, tpqn } = part;
  if (!progression?.length || !timestamps?.length || !measures?.length || !tpqn) return null;

  const voice0 = (mi: number) => measures[mi]?.voices?.[0]?.beats ?? [];
  const expected = progression.reduce((sum, mi) => sum + voice0(mi).length, 0);
  if (expected !== timestamps.length) return null;

  const measureTicks = measures.map((m) => m.totalTicks || tpqn * 4);

  const anchors: number[][] = [];
  const occurrenceStartMs: number[] = [];
  let k = 0;
  for (const mi of progression) {
    const flat: number[] = [];
    for (const beat of voice0(mi)) {
      flat.push(beat.startTick ?? 0, timestamps[k++]);
    }
    anchors.push(flat);
    occurrenceStartMs.push(
      flat.length ? msAtTickZero(flat) : occurrenceStartMs[occurrenceStartMs.length - 1] ?? 0,
    );
  }

  for (let i = 0; i < anchors.length; i++) {
    const flat = anchors[i];
    const len = measureTicks[progression[i]];
    let endMs = occurrenceStartMs[i + 1];
    if (endMs === undefined) {
      const n = flat.length / 2;
      const slope =
        n >= 2 && flat[(n - 1) * 2] > flat[(n - 2) * 2]
          ? (flat[(n - 1) * 2 + 1] - flat[(n - 2) * 2 + 1]) / (flat[(n - 1) * 2] - flat[(n - 2) * 2])
          : 60_000 / (120 * tpqn);
      endMs = n ? flat[(n - 1) * 2 + 1] + Math.max(0, len - flat[(n - 1) * 2]) * slope : occurrenceStartMs[i];
      occurrenceStartMs.push(endMs);
    }
    // Over-filled measures keep their own beat anchors; only close the measure when it ends later.
    const lastTick = flat.length ? flat[flat.length - 2] : -1;
    if (len > lastTick) flat.push(len, endMs);
  }

  return {
    songId: part.songId ?? 0,
    revisionId: part.revisionId ?? 0,
    partId: part.partId ?? -1,
    tpqn,
    progression: [...progression],
    occurrenceStartMs,
    measureTicks,
    anchors,
  };
}

function pollTiming(s: SongsterrStore | null): void {
  const part = s?.state.part?.current;
  if (!part) return;
  const key = `${part.songId}:${part.revisionId}:${part.partId}:${part.timestamps?.length ?? 0}`;
  if (key === timingKey) return;
  const timing = extractTiming(part);
  if (!timing) return;
  timingKey = key;
  timingMessage = { type: "song-timing", timing };
  postToBridge(timingMessage);
}

// --- Current song -----------------------------------------------------------
//
// Songsterr switches songs client-side, so the server-rendered #state keeps describing the first
// song. The store's meta.current follows navigation; when it changes, tracks cached for the
// previous song must go.

let currentSongId: number | null = null;
let metaMessage: SongMetaMessage | null = null;
let metaKey = "";

function pollMeta(s: SongsterrStore | null): void {
  const meta = parseMeta(s?.state.meta?.current);
  if (!meta) return;
  const key = `${meta.songId}:${meta.revisionId}`;
  if (key === metaKey) return;
  metaKey = key;
  if (meta.songId !== currentSongId) {
    currentSongId = meta.songId;
    for (const [partId, msg] of trackCache) if (msg.songId !== meta.songId) trackCache.delete(partId);
    if (timingMessage && timingMessage.timing.songId !== meta.songId) timingMessage = null;
    clearTrackStash();
    for (const msg of trackCache.values()) writeTrackStash(msg.partId, msg.data);
  }
  metaMessage = { type: "song-meta", meta };
  postToBridge(metaMessage);
}

// --- Bridge ---------------------------------------------------------------

function replayToContent(): void {
  const messages: BridgeMessage[] = [{ type: "ready" }];
  if (metaMessage) messages.push(metaMessage);
  messages.push(...trackCache.values());
  if (timingMessage) messages.push(timingMessage);
  postToBridge({ type: "replay", messages });
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data as { channel?: string; type?: string } | null;
  if (!data || typeof data !== "object" || data.channel !== CMD_CHANNEL) return;
  if (data.type === "hello" || data.type === "request-replay") replayToContent();
}

function boot(): void {
  hookFetch();
  window.addEventListener("message", onWindowMessage);
  postToBridge({ type: "ready" });
  window.setInterval(tick, 50);
  window.setInterval(() => {
    const s = getStore();
    pollMeta(s);
    pollTiming(s);
  }, 1000);
  window.setInterval(backfillTrackJson, 2000);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", backfillTrackJson, { once: true });
  } else {
    backfillTrackJson();
  }
}

boot();
