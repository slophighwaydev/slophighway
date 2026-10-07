import type { SongsterrMeta, SongsterrTrackMeta } from "./types";

type RawState = {
  meta?: {
    current?: {
      songId?: number;
      title?: string;
      artist?: string;
      revisionId?: number;
      image?: string;
      tracks?: SongsterrTrackMeta[];
      defaultTrack?: number;
      popularTrackGuitar?: number;
    };
    songId?: number;
  };
  part?: {
    songId?: number;
    partId?: number;
    revisionId?: number;
  };
};

export function readSongsterrMeta(): SongsterrMeta | null {
  const el = document.getElementById("state");
  if (!el?.textContent) return null;

  try {
    const state = JSON.parse(el.textContent) as RawState;
    const current = state.meta?.current;
    if (!current?.songId || !current.revisionId || !current.image) return null;

    return {
      songId: current.songId,
      title: current.title ?? "Unknown",
      artist: current.artist ?? "Unknown",
      revisionId: current.revisionId,
      image: current.image,
      tracks: current.tracks ?? [],
      defaultTrack: current.defaultTrack,
      popularTrackGuitar: current.popularTrackGuitar,
    };
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
