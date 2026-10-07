import type { SongsterrMeta, SongsterrTrackMeta } from "./types";

/** Shape of `meta.current`, both in the server-rendered `#state` and in the live app store. */
export type RawMetaCurrent = {
  songId?: number;
  title?: string;
  artist?: string;
  revisionId?: number;
  image?: string;
  tracks?: SongsterrTrackMeta[];
  defaultTrack?: number;
  popularTrackGuitar?: number;
};

type RawState = {
  meta?: {
    current?: RawMetaCurrent;
    songId?: number;
  };
  part?: {
    songId?: number;
    partId?: number;
    revisionId?: number;
  };
};

export function parseMeta(current: RawMetaCurrent | null | undefined): SongsterrMeta | null {
  if (!current?.songId || !current.revisionId || !current.image) return null;
  return {
    songId: current.songId,
    title: current.title ?? "Unknown",
    artist: current.artist ?? "Unknown",
    revisionId: current.revisionId,
    image: current.image,
    tracks: (current.tracks ?? []).map((t) => ({ ...t })),
    defaultTrack: current.defaultTrack,
    popularTrackGuitar: current.popularTrackGuitar,
  };
}

/**
 * The server-rendered `#state` describes the song the page was first loaded with; it goes stale
 * after Songsterr navigates to another song client-side, so only use it before the live store reports.
 */
export function readSongsterrMeta(): SongsterrMeta | null {
  const el = document.getElementById("state");
  if (!el?.textContent) return null;
  try {
    return parseMeta((JSON.parse(el.textContent) as RawState).meta?.current);
  } catch {
    return null;
  }
}

export function trackJsonUrl(
  songId: number,
  revisionId: number,
  image: string,
  partId: number,
  cdn = "https://dqsljvtekg760.cloudfront.net",
): string {
  return `${cdn}/${songId}/${revisionId}/${image}/${partId}.json`;
}
