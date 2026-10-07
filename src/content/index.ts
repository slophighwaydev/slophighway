import {
  isBridgeEnvelope,
  postCommand,
  readTrackStash,
  type BridgeMessage,
} from "../shared/messages";
import { readSongsterrMeta, trackJsonUrl } from "../songsterr/state";
import { buildRsArrangement, type RsArrangement } from "../songsterr/rocksmith";
import type { SongTiming, SongsterrMeta, SongsterrTrack } from "../songsterr/types";
import { mountOverlay } from "../overlay/ui";

const arrangements = new Map<number, RsArrangement>();
const rawTracks = new Map<number, SongsterrTrack>();
let timing: SongTiming | null = null;
/** Set from the live store once inject reports it; until then the page's initial #state. */
let liveMeta: SongsterrMeta | null = null;
let liveMetaReported = false;

function currentMeta(): SongsterrMeta | null {
  return liveMetaReported ? liveMeta : readSongsterrMeta();
}

function timingFor(track: SongsterrTrack): SongTiming | null {
  if (!timing) return null;
  const meta = currentMeta();
  const songId = track.songId ?? meta?.songId;
  if (songId && timing.songId && songId !== timing.songId) return null;
  return timing;
}

function safeMount() {
  try {
    return mountOverlay();
  } catch (err) {
    console.error("[slophighway] overlay mount failed", err);
    const fallback = document.createElement("div");
    fallback.id = "shh-root";
    fallback.textContent = `Slophighway failed to mount: ${String(err)}`;
    fallback.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#400;color:#fff;padding:12px;font:14px sans-serif";
    document.documentElement.appendChild(fallback);
    return {
      setArrangements() {},
      setSongInfo() {},
      setPlayback() {},
      setStatus(text: string) {
        fallback.textContent = text;
      },
      destroy() {
        fallback.remove();
      },
    };
  }
}

const overlay = safeMount();
overlay.setStatus("content script loaded…");
console.info("[slophighway] content script active");

function trackSignature(track: SongsterrTrack): string {
  return `${track.songId ?? ""}:${track.revisionId ?? ""}:${track.measures.length}:${track.name}`;
}

function publishArrangements(): void {
  overlay.setArrangements([...arrangements.values()], timing?.partId);
}

function upsertTrack(partId: number, data: unknown): void {
  const track = data as SongsterrTrack;
  if (!track?.measures?.length) {
    console.warn("[slophighway] track without measures", partId, data);
    return;
  }
  const meta = currentMeta();
  if (meta?.songId && track.songId && track.songId !== meta.songId) return;
  track.partId = partId;
  const metaTrack = meta?.tracks.find((t) => t.partId === partId);
  if (!track.name?.trim()) track.name = metaTrack?.name?.trim() || metaTrack?.instrument || `Track ${partId + 1}`;
  const known = rawTracks.get(partId);
  if (known && trackSignature(known) === trackSignature(track)) return;
  rawTracks.set(partId, track);
  const arrangement = buildRsArrangement(track, timingFor(track));
  arrangements.set(partId, arrangement);
  publishArrangements();
  overlay.setStatus(
    `${arrangements.size} track(s) · ${arrangement.noteCount} notes · timing:${arrangement.timingSource}`,
  );
  console.info(
    "[slophighway] arrangement ready",
    arrangement.name,
    arrangement.noteCount,
    arrangement.timingSource,
  );
}

function timingKey(t: SongTiming | null): string {
  if (!t) return "";
  return `${t.songId}:${t.revisionId}:${t.progression.length}:${t.occurrenceStartMs[t.occurrenceStartMs.length - 1]}`;
}

function applyTiming(next: SongTiming): void {
  const sameTiming = timingKey(next) === timingKey(timing);
  const samePart = next.partId === timing?.partId;
  timing = next;
  if (sameTiming) {
    if (!samePart) publishArrangements();
    return;
  }
  if (!rawTracks.size) return;
  for (const [partId, track] of rawTracks) {
    arrangements.set(partId, buildRsArrangement(track, timingFor(track)));
  }
  publishArrangements();
  overlay.setStatus(`${arrangements.size} track(s) · timing:songsterr`);
}

function loadFromStash(): number {
  const stash = readTrackStash();
  let n = 0;
  for (const [partId, data] of Object.entries(stash)) {
    if (arrangements.has(Number(partId))) continue;
    upsertTrack(Number(partId), data);
    n++;
  }
  return n;
}

/** Song (and revision) the current arrangements were built for. */
let loadedSong = "";
const songKey = (meta: SongsterrMeta) => `${meta.songId}:${meta.revisionId}`;

function applyMeta(meta: SongsterrMeta): void {
  liveMeta = meta;
  liveMetaReported = true;
  overlay.setSongInfo({ title: meta.title, artist: meta.artist });
  if (songKey(meta) === loadedSong) return;
  arrangements.clear();
  rawTracks.clear();
  if (timing && timing.songId !== meta.songId) timing = null;
  overlay.setArrangements([]);
  void hydrateFromDomState();
}

async function hydrateFromDomState(): Promise<void> {
  const fromStash = loadFromStash();
  if (fromStash) {
    overlay.setStatus(`loaded ${fromStash} track(s) from stash`);
  }

  const meta = currentMeta();
  if (!meta) {
    overlay.setStatus("waiting for Songsterr song data…");
    return;
  }

  loadedSong = songKey(meta);
  overlay.setSongInfo({ title: meta.title, artist: meta.artist });
  overlay.setStatus(`${meta.artist} — ${meta.title} · fetching tracks…`);

  const results = await Promise.all(
    meta.tracks.map(async (t) => {
      if (arrangements.has(t.partId)) return `skip:${t.partId}`;
      if (t.isDrums) return `drums:${t.partId}`;
      const url = trackJsonUrl(meta.songId, meta.revisionId, meta.image, t.partId);
      try {
        const res = await fetch(url);
        if (!res.ok) return `http:${res.status}:${t.partId}`;
        const data = await res.json();
        // the user may have moved on to another song while this was in flight
        if (loadedSong !== songKey(meta)) return `stale:${t.partId}`;
        upsertTrack(t.partId, data);
        return `ok:${t.partId}`;
      } catch (err) {
        console.warn("[slophighway] fetch failed", url, err);
        return `err:${t.partId}`;
      }
    }),
  );

  if (!arrangements.size) {
    overlay.setStatus(`no tracks yet (${results.join(", ")}) — requesting replay…`);
    postCommand("request-replay");
  } else {
    overlay.setStatus(
      `${meta.artist} — ${meta.title} · ${arrangements.size} arrangement(s)`,
    );
  }
}

function onTrackJson(songId: number, partId: number, data: unknown): void {
  const current = currentMeta()?.songId;
  if (current && songId && songId !== current) return;
  upsertTrack(partId, data);
}

function onBridge(payload: BridgeMessage): void {
  switch (payload.type) {
    case "ready":
      overlay.setStatus("inject ready");
      void hydrateFromDomState();
      break;
    case "replay":
      for (const msg of payload.messages) {
        if (msg.type === "song-meta") applyMeta(msg.meta);
      }
      for (const msg of payload.messages) {
        if (msg.type === "song-timing") applyTiming(msg.timing);
      }
      for (const msg of payload.messages) {
        if (msg.type === "track-json") onTrackJson(msg.songId, msg.partId, msg.data);
      }
      if (!arrangements.size) void hydrateFromDomState();
      break;
    case "song-meta":
      applyMeta(payload.meta);
      break;
    case "track-json":
      onTrackJson(payload.songId, payload.partId, payload.data);
      break;
    case "song-timing":
      applyTiming(payload.timing);
      break;
    case "player-tick":
      overlay.setPlayback(
        payload.timeMs,
        payload.playing,
        payload.speed,
        payload.source,
      );
      break;
    case "debug":
      console.debug("[slophighway]", payload.message);
      break;
    default:
      break;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isBridgeEnvelope(event.data)) return;
  onBridge(event.data.payload);
});

// Ask MAIN-world inject to replay anything it already captured.
postCommand("hello");
postCommand("request-replay");

const stashEl = document.getElementById("shh-track-stash");
if (stashEl) {
  const obs = new MutationObserver(() => loadFromStash());
  obs.observe(stashEl, { characterData: true, childList: true, subtree: true });
} else {
  const obs = new MutationObserver(() => {
    if (document.getElementById("shh-track-stash")) {
      loadFromStash();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

// Song changes are driven by the "song-meta" reports (the URL also changes on track switches);
// a URL change just asks inject for a fresh replay.
let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    postCommand("request-replay");
  }
  // Keep pinging until we have notes.
  if (!arrangements.size) {
    postCommand("request-replay");
    loadFromStash();
  }
}, 1500);

void hydrateFromDomState();
