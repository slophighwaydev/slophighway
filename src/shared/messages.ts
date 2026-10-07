import type { SongTiming } from "../songsterr/types";

export const CHANNEL = "songsterr-highway";
export const CMD_CHANNEL = "songsterr-highway-cmd";
export const STASH_ID = "shh-track-stash";

export type TrackJsonMessage = {
  type: "track-json";
  url: string;
  songId: number;
  revisionId: number;
  partId: number;
  data: unknown;
};

export type PlayerTickMessage = {
  type: "player-tick";
  timeMs: number;
  playing: boolean;
  speed: number;
  source: "songsterr" | "estimate";
};

export type SongTimingMessage = {
  type: "song-timing";
  timing: SongTiming;
};

export type BridgeMessage =
  | TrackJsonMessage
  | PlayerTickMessage
  | SongTimingMessage
  | { type: "ready" }
  | { type: "debug"; message: string }
  | { type: "replay"; messages: BridgeMessage[] };

export function postToBridge(payload: BridgeMessage): void {
  window.postMessage({ channel: CHANNEL, payload }, "*");
}

export function postCommand(type: string, extra: Record<string, unknown> = {}): void {
  window.postMessage({ channel: CMD_CHANNEL, type, ...extra }, "*");
}

export function isBridgeEnvelope(
  data: unknown,
): data is { channel: string; payload: BridgeMessage } {
  return (
    typeof data === "object" &&
    data !== null &&
    "channel" in data &&
    (data as { channel: unknown }).channel === CHANNEL &&
    "payload" in data
  );
}

export function writeTrackStash(partId: number, data: unknown): void {
  let el = document.getElementById(STASH_ID) as HTMLScriptElement | null;
  if (!el) {
    el = document.createElement("script");
    el.id = STASH_ID;
    el.type = "application/json";
    (document.documentElement || document.head || document.body).appendChild(el);
  }
  let stash: Record<string, unknown> = {};
  try {
    stash = JSON.parse(el.textContent || "{}") as Record<string, unknown>;
  } catch {
    stash = {};
  }
  stash[String(partId)] = data;
  el.textContent = JSON.stringify(stash);
  el.dataset.updatedAt = String(Date.now());
}

export function readTrackStash(): Record<string, unknown> {
  const el = document.getElementById(STASH_ID);
  if (!el?.textContent) return {};
  try {
    return JSON.parse(el.textContent) as Record<string, unknown>;
  } catch {
    return {};
  }
}
