import {
  isBridgeEnvelope,
  postCommand,
  readTrackStash,
  type BridgeMessage,
} from "../shared/messages";
import { readSongsterrMeta, trackJsonUrl } from "../songsterr/state";
import { buildRsArrangement, type RsArrangement } from "../songsterr/rocksmith";
import type { SongTiming, SongsterrTrack } from "../songsterr/types";
import { mountOverlay } from "../overlay/ui";

const arrangements = new Map<number, RsArrangement>();
const rawTracks = new Map<number, SongsterrTrack>();
let timing: SongTiming | null = null;

function timingFor(track: SongsterrTrack): SongTiming | null {
  if (!timing) return null;
  const meta = readSongsterrMeta();
  const songId = track.songId ?? meta?.songId;
  if (songId && timing.songId && songId !== timing.songId) return null;
  return timing;
}

function safeMount() {
  try {
    return mountOverlay();
  } catch (err) {
    console.error("[songsterr-highway] overlay mount failed", err);
    const fallback = document.createElement("div");
    fallback.id = "shh-root";
    fallback.textContent = `Songsterr Highway failed to mount: ${String(err)}`;
    fallback.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#400;color:#fff;padding:12px;font:14px sans-serif";
    document.documentElement.appendChild(fallback);
    return {
      setArrangements() {},
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
console.info("[songsterr-highway] content script active");

function trackSignature(track: SongsterrTrack): string {
  return `${track.songId ?? ""}:${track.revisionId ?? ""}:${track.measures.length}:${track.name}`;
}

function publishArrangements(): void {
  overlay.setArrangements([...arrangements.values()], timing?.partId);
}

function upsertTrack(partId: number, data: unknown): void {
  const track = data as SongsterrTrack;
  if (!track?.measures?.length) {
    console.warn("[songsterr-highway] track without measures", partId, data);
    return;
  }
  track.partId = partId;
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
    "[songsterr-highway] arrangement ready",
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

async function hydrateFromDomState(): Promise<void> {
  const fromStash = loadFromStash();
  if (fromStash) {
    overlay.setStatus(`loaded ${fromStash} track(s) from stash`);
  }

  const meta = readSongsterrMeta();
  if (!meta) {
    overlay.setStatus("waiting for Songsterr #state…");
    return;
  }

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
        upsertTrack(t.partId, data);
        return `ok:${t.partId}`;
      } catch (err) {
        console.warn("[songsterr-highway] fetch failed", url, err);
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

function onBridge(payload: BridgeMessage): void {
  switch (payload.type) {
    case "ready":
      overlay.setStatus("inject ready");
      void hydrateFromDomState();
      break;
    case "replay":
      for (const msg of payload.messages) {
        if (msg.type === "song-timing") applyTiming(msg.timing);
      }
      for (const msg of payload.messages) {
        if (msg.type === "track-json") upsertTrack(msg.partId, msg.data);
      }
      if (!arrangements.size) void hydrateFromDomState();
      break;
    case "track-json":
      upsertTrack(payload.partId, payload.data);
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
      console.debug("[songsterr-highway]", payload.message);
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

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    arrangements.clear();
    rawTracks.clear();
    timing = null;
    overlay.setArrangements([]);
    postCommand("hello");
    void hydrateFromDomState();
  }
  // Keep pinging until we have notes.
  if (!arrangements.size) {
    postCommand("request-replay");
    loadFromStash();
  }
}, 1500);

void hydrateFromDomState();
