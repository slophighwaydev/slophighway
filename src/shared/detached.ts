import type { RsArrangement } from "../songsterr/rocksmith";
import type { SongInfo } from "../overlay/tracks";

/** Port name used between the Songsterr tab (content script) and the detached highway window. */
export const DETACHED_PORT = "shh-detached";

/** Runtime message the content script sends to the background to open (or focus) the window. */
export const OPEN_DETACHED = "shh-open-detached";

export type TrackSummary = { partId: number; name: string; noteCount: number };

export type ToDetached =
  | { type: "tracks"; tracks: TrackSummary[] }
  | { type: "song"; song: SongInfo | null }
  /** Already converted to E standard when `standard` is on. */
  | { type: "arrangement"; arrangement: RsArrangement | null }
  | { type: "settings"; standard: boolean }
  /** `sentAt` is `Date.now()` in the tab, so the window can compensate for message latency. */
  | { type: "playback"; timeMs: number; playing: boolean; speed: number; sentAt: number }
  | { type: "close" };

export type FromDetached =
  | { type: "select"; partId: number }
  | { type: "set-standard"; enabled: boolean }
  | { type: "toggle-play" };
