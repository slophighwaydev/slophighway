export type SongsterrBendPoint = { position: number; tone: number; precisePosition?: number };

export type SongsterrNote = {
  string: number;
  fret: number;
  rest?: boolean;
  tie?: boolean;
  /** Hammer-on / pull-off from this note to the next one on the same string. */
  hp?: boolean;
  bend?: { tone: number; points?: SongsterrBendPoint[] };
  /** "shift" | "legato" | "upwards" | "downwards" | "below" | "above" | "belowshift" | "abovelegato" … */
  slide?: string;
  /** "natural" | "pinch" | "artificial" | "semi" | "tapped" */
  harmonic?: string;
  harmonicFret?: number;
  /** "slight" | "wide" */
  leftHandVibrato?: string;
  dead?: boolean;
  ghost?: boolean;
  accentuated?: number;
  staccato?: boolean;
  tremolo?: boolean;
  trill?: { auxiliaryFret: number; speed: number };
};

export type SongsterrBeat = {
  type?: number;
  notes?: SongsterrNote[];
  velocity?: string | number;
  tempo?: { bpm: number; type?: number };
  duration?: [number, number];
  dots?: number;
  tuplet?: number;
  rest?: boolean;
  palmMute?: boolean;
  tapping?: boolean;
  letRing?: boolean;
  /** "beforeBeat" | "onBeat" */
  graceNote?: string;
  chord?: { text?: string };
  text?: { text?: string };
};

export type SongsterrVoice = {
  beats?: SongsterrBeat[];
};

export type SongsterrMeasure = {
  index?: number;
  signature?: [number, number];
  marker?: { text?: string; title?: string };
  voices?: SongsterrVoice[];
  beats?: SongsterrBeat[];
  repeatStart?: boolean;
  /** Total number of plays of the repeated block, set on its closing measure. */
  repeat?: number;
  /** Ending number(s) as a bitmask (1 = first ending, 2 = second, 4 = third …). */
  alternateEnding?: number;
  /** Swing feel, e.g. "8th" or "16th"; applies from this measure on. */
  tripletFeel?: string;
  rest?: boolean;
};

export type SongsterrTempoEvent = {
  bpm: number;
  /** 0-based measure index. */
  measure: number;
  /** Fraction of the measure (0..1). */
  position?: number;
  /** Note value the bpm counts (4 = quarter, 2 = half, 8 = eighth). */
  type?: number;
  linear?: boolean;
  visible?: boolean;
};

export type SongsterrTrack = {
  strings: number;
  frets: number;
  tuning: number[];
  name: string;
  instrument: string;
  instrumentId: number;
  volume?: number;
  balance?: number;
  measures: SongsterrMeasure[];
  capo?: number;
  voices?: number;
  automations?: { tempo?: SongsterrTempoEvent[] };
  version?: number;
  songId?: number;
  partId?: number;
  revisionId?: number;
};

export type SongsterrTrackMeta = {
  instrumentId: number;
  instrument: string;
  name: string;
  tuning: number[];
  partId: number;
  hash?: string;
  isGuitar?: boolean;
  isBassGuitar?: boolean;
  isDrums?: boolean;
};

export type SongsterrMeta = {
  songId: number;
  title: string;
  artist: string;
  revisionId: number;
  image: string;
  tracks: SongsterrTrackMeta[];
  defaultTrack?: number;
  popularTrackGuitar?: number;
};

/**
 * Song-wide timing extracted from Songsterr's processed part (`store.state.part.current`).
 * Repeats are already expanded, and times are in the same ms base as `player.getPosition().cursor`.
 */
export type SongTiming = {
  songId: number;
  revisionId: number;
  /** Part currently shown in Songsterr's tab view. */
  partId: number;
  tpqn: number;
  /** Measure index for each played occurrence, in playback order. */
  progression: number[];
  /** Start time (ms) of each occurrence; one extra entry at the end marks the song end. */
  occurrenceStartMs: number[];
  /** Per measure index: total ticks. */
  measureTicks: number[];
  /** Per occurrence: flattened [tickInMeasure, ms, tickInMeasure, ms, …] from voice-0 beats. */
  anchors: number[][];
};
