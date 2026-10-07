import type { RsArrangement, RsNote } from "./rocksmith";

/** Standard tunings as MIDI pitches, lowest string first. */
const STANDARD_GUITAR: Record<number, number[]> = {
  6: [40, 45, 50, 55, 59, 64],
  7: [35, 40, 45, 50, 55, 59, 64],
  8: [30, 35, 40, 45, 50, 55, 59, 64],
};
const STANDARD_BASS: Record<number, number[]> = {
  4: [28, 33, 38, 43],
  5: [23, 28, 33, 38, 43],
  6: [23, 28, 33, 38, 43, 48],
};

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
const noteName = (midi: number) => NOTE_NAMES[((midi % 12) + 12) % 12];

function standardFor(arr: RsArrangement): number[] | null {
  const table = /bass/i.test(arr.instrument) ? STANDARD_BASS : STANDARD_GUITAR;
  return table[arr.strings] ?? null;
}

/** Songsterr lists tuning highest string first; Rocksmith works lowest string first. */
function lowToHigh(arr: RsArrangement): number[] {
  return [...(arr.tuning ?? [])].reverse();
}

/** Semitone offset per string from standard, lowest string first (Rocksmith convention). */
export function tuningOffsets(arr: RsArrangement): number[] {
  const tuning = lowToHigh(arr);
  const standard = standardFor(arr);
  if (!standard || tuning.length !== standard.length) return new Array(arr.strings).fill(0);
  return tuning.map((midi, i) => midi - standard[i]);
}

/** Most common offset (ties go to the higher one): the shift shared by the "shape" strings. */
function baseOffset(offsets: number[]): number {
  const counts = new Map<number, number>();
  for (const o of offsets) counts.set(o, (counts.get(o) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [o, c] of counts) {
    if (c > bestCount || (c === bestCount && o > best)) {
      best = o;
      bestCount = c;
    }
  }
  return best;
}

export function tuningName(arr: RsArrangement): string {
  const tuning = lowToHigh(arr);
  const standard = standardFor(arr);
  if (!standard || tuning.length !== standard.length) return tuning.map(noteName).join(" ");
  const offsets = tuning.map((midi, i) => midi - standard[i]);
  const base = baseOffset(offsets);
  const odd = offsets.map((o, i) => (o === base ? -1 : i)).filter((i) => i >= 0);
  // name standard tunings after the E string (the 4th from the top on bass and guitar alike)
  const eString = standard[standard.length - 1 - (/bass/i.test(arr.instrument) ? 3 : 0)];
  if (!odd.length) return `${noteName(eString + base)} Standard`;
  if (odd.length === 1 && odd[0] === 0 && offsets[0] === base - 2) return `Drop ${noteName(tuning[0])}`;
  return tuning.map(noteName).join(" ");
}

export function isStandardTuning(arr: RsArrangement): boolean {
  return tuningOffsets(arr).every((o) => o === 0);
}

/**
 * The same chart re-fretted for E standard. Strings tuned down together keep their shapes (the chart
 * sounds higher, as when you play along with Songsterr's transpose); strings tuned apart from the rest,
 * like the low string in Drop D, are re-fretted to keep their pitch relative to the others. Frets that
 * would go below the nut move up an octave.
 */
export function retuneToStandard(arr: RsArrangement): RsArrangement {
  const standard = standardFor(arr);
  if (!standard || isStandardTuning(arr)) return arr;
  const offsets = tuningOffsets(arr);
  const base = baseOffset(offsets);
  const delta = offsets.map((o) => o - base);
  const fret = (s: number, f: number) => {
    if (f < 0) return f;
    const next = f + (delta[s] ?? 0);
    return next < 0 ? next + 12 : next;
  };
  const note = (n: RsNote): RsNote => ({
    ...n,
    f: fret(n.s, n.f),
    sl: n.sl >= 0 ? fret(n.s, n.sl) : n.sl,
    slu: n.slu >= 0 ? fret(n.s, n.slu) : n.slu,
  });
  return {
    ...arr,
    tuning: [...standard].reverse(),
    notes: arr.notes.map(note),
    chords: arr.chords.map((c) => ({ ...c, notes: c.notes.map(note) })),
    chordTemplates: arr.chordTemplates.map((t) => ({ ...t, frets: t.frets.map((f, s) => fret(s, f)) })),
    retunedFrom: tuningName(arr),
  };
}
