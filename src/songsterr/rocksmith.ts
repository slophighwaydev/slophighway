import type {
  SongTiming,
  SongsterrBeat,
  SongsterrMeasure,
  SongsterrNote,
  SongsterrTempoEvent,
  SongsterrTrack,
} from "./types";

/**
 * Rocksmith-style chart model, shaped like the Slopsmith renderer bundle
 * (`t`/`sus` in seconds, string 0 = lowest string).
 */
export type RsNote = {
  t: number;
  s: number;
  f: number;
  sus: number;
  /** Bend amount in semitones. */
  bn?: number;
  ho?: boolean;
  po?: boolean;
  tp?: boolean;
  /** Pitched slide target fret, -1 = none. */
  sl: number;
  /** Unpitched slide target fret, -1 = none. */
  slu: number;
  pm?: boolean;
  mt?: boolean;
  hm?: boolean;
  hp?: boolean;
  vb?: boolean;
  tr?: boolean;
  ac?: boolean;
};

export type RsChord = { t: number; id: number; notes: RsNote[] };
export type RsChordTemplate = { name: string; displayName: string; frets: number[]; fingers: number[] };
export type RsBeat = { time: number; measure: number };
export type RsSection = { time: number; name: string };

export type RsArrangement = {
  partId: number;
  name: string;
  instrument: string;
  strings: number;
  tuning: number[];
  capo: number;
  notes: RsNote[];
  chords: RsChord[];
  chordTemplates: RsChordTemplate[];
  beats: RsBeat[];
  sections: RsSection[];
  durationSec: number;
  timingSource: "songsterr" | "computed";
  noteCount: number;
  /** Original tuning name when the chart was converted to E standard. */
  retunedFrom?: string;
};

const SUSTAIN_MIN_SEC = 0.35;
const OUT_SLIDE_FRETS = 4;
/** Ticks per quarter note used when Songsterr's own timing isn't available. */
const FALLBACK_TPQN = 960;

const KNOWN_SLIDES = new Set([
  "shift",
  "legato",
  "upwards",
  "downwards",
  "below",
  "above",
  "belowshift",
  "belowlegato",
  "aboveshift",
  "abovelegato",
]);
const KNOWN_HARMONICS = new Set(["natural", "pinch", "artificial", "semi", "tapped"]);
const reportedUnknown = new Set<string>();

function reportUnknown(kind: string, value: unknown): void {
  const key = `${kind}=${String(value)}`;
  if (reportedUnknown.has(key)) return;
  reportedUnknown.add(key);
  console.info("[slophighway] unmapped technique", key);
}

/** `duration` is a fraction of a whole note with dots and tuplets already applied. */
function beatTicks(beat: SongsterrBeat, tpqn: number): number {
  const [n, d] = beat.duration ?? [1, beat.type ?? 4];
  return (tpqn * 4 * n) / d;
}

function measureBeats(measure: SongsterrMeasure): SongsterrBeat[][] {
  if (measure.voices?.length) return measure.voices.map((v) => v.beats ?? []);
  return [measure.beats ?? []];
}

/** Playback order of measure indices, expanding repeats and alternate endings. */
export function expandRepeats(measures: SongsterrMeasure[]): number[] {
  const order: number[] = [];
  let blockStart = 0;
  let pass = 1;
  let jumpedBack = false;
  let guard = 0;
  for (let i = 0; i < measures.length && guard < 100_000; guard++) {
    const m = measures[i];
    if (m.repeatStart && !jumpedBack) {
      blockStart = i;
      pass = 1;
    }
    jumpedBack = false;
    if (m.alternateEnding && !(m.alternateEnding & (1 << (pass - 1)))) {
      i++;
      continue;
    }
    order.push(i);
    if (m.repeat && m.repeat > 1) {
      if (pass < m.repeat) {
        pass++;
        i = blockStart;
        jumpedBack = true;
        continue;
      }
      pass = 1;
      blockStart = i + 1;
    }
    i++;
  }
  return order;
}

type MeasureClock = (tick: number) => number;

function anchorClock(anchors: number[], fallbackMsPerTick: number): MeasureClock {
  return (tick) => {
    const n = anchors.length / 2;
    if (n === 0) return tick * fallbackMsPerTick;
    if (n === 1 || tick <= anchors[0]) {
      return anchors[1] + (tick - anchors[0]) * fallbackMsPerTick;
    }
    for (let i = 1; i < n; i++) {
      const t1 = anchors[i * 2];
      if (tick <= t1 || i === n - 1) {
        const t0 = anchors[(i - 1) * 2];
        const ms0 = anchors[(i - 1) * 2 + 1];
        const ms1 = anchors[i * 2 + 1];
        const slope = t1 > t0 ? (ms1 - ms0) / (t1 - t0) : fallbackMsPerTick;
        return ms0 + (tick - t0) * slope;
      }
    }
    return anchors[anchors.length - 1];
  };
}

function quarterBpm(ev: SongsterrTempoEvent): number {
  return (ev.bpm * 4) / (ev.type || 4);
}

type Occurrence = {
  measure: number;
  startMs: number;
  endMs: number;
  lengthTicks: number;
  clock: MeasureClock;
};

function buildOccurrences(
  track: SongsterrTrack,
  timing: SongTiming | null,
): { occurrences: Occurrence[]; tpqn: number; source: "songsterr" | "computed" } {
  const measures = track.measures;
  const usable =
    timing &&
    timing.progression.length > 0 &&
    timing.progression.every((mi) => mi >= 0 && mi < measures.length) &&
    timing.occurrenceStartMs.length === timing.progression.length + 1;

  if (usable && timing) {
    const occurrences = timing.progression.map((mi, k) => {
      const startMs = timing.occurrenceStartMs[k];
      const endMs = timing.occurrenceStartMs[k + 1];
      const lengthTicks = timing.measureTicks[mi] || timing.tpqn * 4;
      const fallback = (endMs - startMs) / lengthTicks;
      const anchors = timing.anchors[k]?.length ? timing.anchors[k] : [0, startMs, lengthTicks, endMs];
      return { measure: mi, startMs, endMs, lengthTicks, clock: anchorClock(anchors, fallback) };
    });
    return { occurrences, tpqn: timing.tpqn, source: "songsterr" };
  }

  // Songsterr's player applies a tempo change at the start of its measure, whatever its `position`.
  const tpqn = FALLBACK_TPQN;
  const tempo = [...(track.automations?.tempo ?? [])].sort(
    (a, b) => a.measure - b.measure || (a.position ?? 0) - (b.position ?? 0),
  );
  const firstBeatBpm = measures[0]?.voices?.[0]?.beats?.[0]?.tempo?.bpm;
  const defaultQpm = tempo[0] ? quarterBpm(tempo[0]) : firstBeatBpm ?? 120;
  const qpmAt = (mi: number): number => {
    let qpm = defaultQpm;
    for (const ev of tempo) {
      if (ev.measure <= mi) qpm = quarterBpm(ev);
      else break;
    }
    return qpm;
  };

  // Songsterr advances by the time signature even when a voice is over- or under-filled;
  // only a short first measure (pickup) is shortened to its content.
  let signature: [number, number] = [4, 4];
  const lengths = measures.map((m, mi) => {
    if (m.signature) signature = m.signature;
    const nominal = (tpqn * 4 * signature[0]) / signature[1];
    if (mi !== 0) return nominal;
    const content = Math.max(
      0,
      ...measureBeats(m).map((beats) =>
        beats.reduce((sum, b) => sum + (b.graceNote ? 0 : beatTicks(b, tpqn)), 0),
      ),
    );
    return content > 0 ? Math.min(nominal, content) : nominal;
  });

  let cursor = 0;
  const occurrences = expandRepeats(measures).map((mi) => {
    const lengthTicks = lengths[mi];
    const msPerTick = 60_000 / (qpmAt(mi) * tpqn);
    const startMs = cursor;
    cursor += lengthTicks * msPerTick;
    return {
      measure: mi,
      startMs,
      endMs: cursor,
      lengthTicks,
      clock: anchorClock([0, startMs, lengthTicks, cursor], msPerTick),
    };
  });
  return { occurrences, tpqn, source: "computed" };
}

type BeatEvent = {
  startMs: number;
  endMs: number;
  beat: SongsterrBeat;
  order: number;
};

/** Swing unit in ticks per measure (eighth feel swings eighth pairs on each quarter), carried forward. */
function swingUnits(measures: SongsterrMeasure[], tpqn: number): number[] {
  let unit = 0;
  return measures.map((m) => {
    const feel = m.tripletFeel;
    if (feel !== undefined) {
      if (/16/.test(feel)) unit = tpqn / 2;
      else if (/8/.test(feel)) unit = tpqn;
      else unit = 0;
    }
    return unit;
  });
}

function isPlain(beat: SongsterrBeat | undefined, den: number): boolean {
  return !!beat && !beat.graceNote && !beat.tuplet && beat.duration?.[0] === 1 && beat.duration?.[1] === den;
}

function collectBeatEvents(track: SongsterrTrack, occurrences: Occurrence[], tpqn: number): BeatEvent[] {
  const events: BeatEvent[] = [];
  const swing = swingUnits(track.measures, tpqn);
  let order = 0;
  for (const occ of occurrences) {
    const unit = swing[occ.measure];
    const swingDen = unit ? Math.round((tpqn * 4) / (unit / 2)) : 0;
    for (const beats of measureBeats(track.measures[occ.measure])) {
      let tick = 0;
      let swungNext = 0;
      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i];
        if (beat.graceNote) {
          const next = beats[i + 1];
          const nextTicks = next ? beatTicks(next, tpqn) : beatTicks(beat, tpqn);
          const graceTicks = Math.min(beatTicks(beat, tpqn), nextTicks / 2);
          const start = beat.graceNote === "onBeat" ? tick : tick - graceTicks;
          events.push({
            startMs: occ.clock(start),
            endMs: occ.clock(start + graceTicks),
            beat,
            order: order++,
          });
          if (beat.graceNote === "onBeat") tick += graceTicks;
          continue;
        }
        let ticks = beatTicks(beat, tpqn);
        if (swungNext) {
          ticks = swungNext;
          swungNext = 0;
        } else if (
          unit &&
          isPlain(beat, swingDen) &&
          isPlain(beats[i + 1], swingDen) &&
          Math.abs(tick / unit - Math.round(tick / unit)) < 1e-6
        ) {
          ticks = (unit * 2) / 3;
          swungNext = unit / 3;
        }
        const prev = beats[i - 1];
        if (prev?.graceNote === "onBeat") {
          const nextTicks = ticks;
          ticks -= Math.min(beatTicks(prev, tpqn), nextTicks / 2);
        }
        events.push({
          startMs: occ.clock(tick),
          endMs: occ.clock(tick + ticks),
          beat,
          order: order++,
        });
        tick += ticks;
      }
    }
  }
  events.sort((a, b) => a.startMs - b.startMs || a.order - b.order);
  return events;
}

type NoteState = {
  note: RsNote;
  endMs: number;
  letRing: boolean;
  hpToNext: boolean;
  slideToNext: boolean;
};

function applySlide(rs: RsNote, slide: string | undefined, state: NoteState): void {
  if (!slide) return;
  if (!KNOWN_SLIDES.has(slide)) reportUnknown("slide", slide);
  if (slide.includes("shift") || slide.includes("legato")) {
    state.slideToNext = true;
  } else if (slide === "downwards") {
    rs.slu = Math.max(0, rs.f - OUT_SLIDE_FRETS);
  } else if (slide === "upwards") {
    rs.slu = rs.f + OUT_SLIDE_FRETS;
  }
}

function applyHarmonic(rs: RsNote, harmonic: string | undefined): void {
  if (!harmonic) return;
  if (!KNOWN_HARMONICS.has(harmonic)) reportUnknown("harmonic", harmonic);
  if (harmonic === "natural") rs.hm = true;
  else rs.hp = true;
}

function toRsNote(n: SongsterrNote, beat: SongsterrBeat, s: number, tSec: number): RsNote {
  const rs: RsNote = { t: tSec, s, f: n.fret, sus: 0, sl: -1, slu: -1 };
  if (n.bend) {
    const peak = Math.max(n.bend.tone ?? 0, ...(n.bend.points ?? []).map((p) => p.tone ?? 0));
    if (peak > 0) rs.bn = peak / 50;
  }
  if (n.leftHandVibrato) rs.vb = true;
  if (n.dead) rs.mt = true;
  if (n.accentuated) rs.ac = true;
  if (n.tremolo) rs.tr = true;
  if (beat.palmMute) rs.pm = true;
  if (beat.tapping) rs.tp = true;
  applyHarmonic(rs, n.harmonic);
  return rs;
}

function chordTemplateId(
  templates: RsChordTemplate[],
  index: Map<string, number>,
  name: string,
  notes: RsNote[],
  strings: number,
): number {
  const frets = new Array<number>(strings).fill(-1);
  for (const n of notes) frets[n.s] = n.f;
  const key = `${name}|${frets.join(",")}`;
  const existing = index.get(key);
  if (existing !== undefined) return existing;
  const id = templates.length;
  templates.push({ name, displayName: name, frets, fingers: new Array<number>(strings).fill(-1) });
  index.set(key, id);
  return id;
}

export function buildRsArrangement(track: SongsterrTrack, timing: SongTiming | null): RsArrangement {
  const strings = Math.max(1, track.strings || track.tuning?.length || 6);
  const { occurrences, tpqn, source } = buildOccurrences(track, timing);
  const events = collectBeatEvents(track, occurrences, tpqn);

  const notes: RsNote[] = [];
  const chords: RsChord[] = [];
  const chordTemplates: RsChordTemplate[] = [];
  const templateIndex = new Map<string, number>();
  const states = new Map<RsNote, NoteState>();
  const lastOnString: Array<NoteState | null> = new Array(strings).fill(null);

  for (const ev of events) {
    const tSec = ev.startMs / 1000;
    const fresh: RsNote[] = [];
    for (const n of ev.beat.notes ?? []) {
      if (n.rest || typeof n.string !== "number" || typeof n.fret !== "number") continue;
      const s = strings - 1 - n.string;
      if (s < 0 || s >= strings) continue;

      const prev = lastOnString[s];
      if (n.tie) {
        if (prev) prev.endMs = Math.max(prev.endMs, ev.endMs);
        continue;
      }

      const rs = toRsNote(n, ev.beat, s, tSec);
      const state: NoteState = {
        note: rs,
        endMs: ev.endMs,
        letRing: !!ev.beat.letRing,
        hpToNext: !!n.hp,
        slideToNext: false,
      };
      applySlide(rs, n.slide, state);

      if (prev) {
        if (prev.hpToNext && rs.f !== prev.note.f) {
          if (rs.f > prev.note.f) rs.ho = true;
          else rs.po = true;
        }
        if (prev.slideToNext && rs.f !== prev.note.f) prev.note.sl = rs.f;
      }

      lastOnString[s] = state;
      states.set(rs, state);
      fresh.push(rs);
    }

    if (fresh.length >= 2) {
      const name = ev.beat.chord?.text?.trim() ?? "";
      const id = chordTemplateId(chordTemplates, templateIndex, name, fresh, strings);
      chords.push({ t: tSec, id, notes: fresh.sort((a, b) => a.s - b.s) });
    } else if (fresh.length === 1) {
      notes.push(fresh[0]);
    }
  }

  for (const [rs, state] of states) {
    const dur = Math.max(0, state.endMs / 1000 - rs.t);
    const needsTrail =
      !!rs.bn || !!rs.vb || !!rs.tr || rs.sl >= 0 || rs.slu >= 0 || state.letRing;
    rs.sus = dur >= SUSTAIN_MIN_SEC || needsTrail ? dur : 0;
  }

  const beats: RsBeat[] = [];
  const sections: RsSection[] = [];
  let signature: [number, number] = [4, 4];
  const signatures = track.measures.map((m) => {
    if (m.signature) signature = m.signature;
    return signature;
  });
  for (const occ of occurrences) {
    const [num, den] = signatures[occ.measure];
    const step = (tpqn * 4) / den;
    for (let i = 0; i < num; i++) {
      beats.push({ time: occ.clock(i * step) / 1000, measure: i === 0 ? occ.measure + 1 : -1 });
    }
    const marker = track.measures[occ.measure].marker?.text?.trim();
    if (marker) sections.push({ time: occ.startMs / 1000, name: marker });
  }

  const lastOcc = occurrences[occurrences.length - 1];
  return {
    partId: track.partId ?? 0,
    name: track.name,
    instrument: track.instrument,
    strings,
    tuning: track.tuning,
    capo: track.capo ?? 0,
    notes,
    chords,
    chordTemplates,
    beats,
    sections,
    durationSec: lastOcc ? lastOcc.endMs / 1000 : 0,
    timingSource: source,
    noteCount: notes.length + chords.reduce((sum, c) => sum + c.notes.length, 0),
  };
}

/** Flat, time-sorted view of every note (single notes plus chord members). */
export function flattenNotes(arr: RsArrangement): RsNote[] {
  const all = [...arr.notes];
  for (const c of arr.chords) all.push(...c.notes);
  return all.sort((a, b) => a.t - b.t);
}
