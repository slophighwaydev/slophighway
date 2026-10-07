// 3D Highway visualization plugin — Three.js note highway.
// Visual layer from joel's prototype (vibrant palette, glowing strings,
// fret heat, dynamic lane, chord frame-boxes, per-note connector labels,
// board projection, outline+core note meshes) adapted into the
// slopsmithViz setRenderer contract (slopsmith#36) so it works in the
// main player and per-panel in splitscreen without any architectural
// changes.

(function () {
    'use strict';

    /* ======================================================================
     *  Constants
     * ====================================================================== */

    // Three.js is vendored under static/vendor/three/ in core (pinned r170 —
    // see static/vendor/three/VERSION). The bundled plugin loads from the
    // same origin to avoid the first-launch CDN round-trip and to pin the
    // version against breakages from upstream Three.js drift.
    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    // Selectable per-string color palettes (issue #10). Each palette has
    // 8 entries to match MAX_RENDER_STRINGS so 6/7/8-string arrangements
    // all index safely. Default is the canonical Rocksmith classic
    // mapping (low E=red, A=yellow, D=blue, G=orange, B=green,
    // high E=purple); Neon pushes saturation harder; Pastel desaturates
    // for long-session comfort; Colorblind (high contrast) is derived from
    // Rocksmith 2014's built-in colorblind-mode palette, but this preset
    // intentionally keeps some entries tuned for slopsmith rather than
    // reproducing every original game hex value verbatim. The RS2014 base
    // values came from the RSMods author's reverse-engineering of the game
    // files; do not treat the tuned values below as the exact in-game
    // palette.
    // In slopsmith's index convention s=0 is the low E (thickest) and
    // s=5 is the high E (thinnest), matching Rocksmith's native string
    // indexing. Per-index ordering is preserved across all palettes so
    // switching between them never reassigns a string to a different
    // colour family. Indices 6/7 are supplementary slots used for
    // 7/8-string arrangements.
    // NOTE: settings.html mirrors these arrays in its hydration script
    // for the palette-preview swatches — keep them in sync.
    const PALETTES = {
        default: [
            0xff2828, 0xffd400, 0x2080ff, 0xff8020,
            0x30d040, 0xa040ff, 0xff6bd5, 0x6bffe6,
        ],
        neon: [
            0xff0030, 0xffe800, 0x0080ff, 0xff8030,
            0x40ff50, 0xb050ff, 0xff40d0, 0x40ffd0,
        ],
        pastel: [
            0xe89aa0, 0xefdf90, 0x9adfee, 0xefb898,
            0xa6e0a8, 0xc4a6e0, 0xe0a6c8, 0xa6e0d8,
        ],
        colorblind_hc: [
            0xa42424, 0xa3f300, 0x19abfc, 0xda7e41,
            0x30d0a0, 0x7648a7, 0xff6bd5, 0x6bffe6,
        ],
    };
    const PALETTE_IDS = Object.keys(PALETTES);
    // Host-facing display names for the panelControls palette descriptor.
    // Single-word ids fall back to a capitalized id (Default/Neon/Pastel);
    // multi-word ids that need a real name are overridden here.
    const PALETTE_LABELS = { colorblind_hc: 'Colorblind (high contrast)' };
    // Default palette at module scope so out-of-IIFE consumers (e.g. the
    // out-of-range warning's reference to "palette size") still have a
    // canonical length to compare against.
    const S_COL = PALETTES.default;

    const SCALE = 2.25;
    const K = SCALE / 300;

    const NFRETS = 24;
    const NSTR = 6;
    /**
     * Pure 12-semitone spacing compresses toward the bridge; multiply each
     * segment **above** this fret by the factor so high positions stay
     * slightly more playable/readable in 3D.
     */
    const FRET_SPACING_STRETCH_ABOVE12 = 1.1;
    const FRET_SPACING_ANCHOR_F = 12;
    // Per-string materials and projection meshes are built via S_COL.map(),
    // so the renderer can only address strings 0..S_COL.length-1. Using a
    // higher count would index undefined into mGlow/mStr/mSus/projMeshArr.
    // Extend S_COL above to support more strings.
    const MAX_RENDER_STRINGS = S_COL.length;

    // Resolve the string count for the active arrangement. Prefer
    // bundle.stringCount (exposed by slopsmith core since #93 — derived
    // from notes/chords/tuning, so it works for 5-string bass, 7- and
    // 8-string guitar, etc.). Fall back to arrangement-name detection
    // for older slopsmith cores that don't emit the field. Clamp to the
    // palette size so a malformed bundle or a 12-string chart doesn't
    // index past the per-string material arrays.
    function resolveStringCount(bundle) {
        const sc = bundle && bundle.stringCount;
        if (Number.isFinite(sc) && sc >= 1) {
            return Math.min(Math.trunc(sc), MAX_RENDER_STRINGS);
        }
        return /bass/i.test(bundle?.songInfo?.arrangement || '') ? 4 : NSTR;
    }

    /** Rocksmith tuning entries are semitone offsets from instrument standard. */
    const _NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Open-string MIDI (thick → thin), matched to RS string index 0 low.
    const _BASE_OPEN_MIDI_BASS4 = Object.freeze([28, 33, 38, 43]);
    const _BASE_OPEN_MIDI_BASS5 = Object.freeze([23, 28, 33, 38, 43]);
    const _BASE_OPEN_MIDI_GUITAR6 = Object.freeze([40, 45, 50, 55, 59, 64]);
    const _BASE_OPEN_MIDI_GUITAR7 = Object.freeze([35, 40, 45, 50, 55, 59, 64]);
    // F#/B/E standard extension — low string is a fifth below RS 7‑string low B.
    const _BASE_OPEN_MIDI_GUITAR8 = Object.freeze([28, 35, 40, 45, 50, 55, 59, 64]);

    function _baseOpenStringMidis(sc, arrangement) {
        const isBass = /bass/i.test(arrangement || '');
        if (sc === 4 && isBass) return _BASE_OPEN_MIDI_BASS4.slice();
        if (sc === 4) return _BASE_OPEN_MIDI_GUITAR6.slice(0, 4);
        if (sc === 5 && isBass) return _BASE_OPEN_MIDI_BASS5.slice();
        if (sc === 5) return _BASE_OPEN_MIDI_GUITAR6.slice(0, 5);
        if (sc === 7) return _BASE_OPEN_MIDI_GUITAR7.slice();
        if (sc === 8) return _BASE_OPEN_MIDI_GUITAR8.slice();
        if (Number.isFinite(sc) && sc > 8) {
            const out = Array.from(_BASE_OPEN_MIDI_GUITAR8);
            let last = out[out.length - 1];
            while (out.length < sc) {
                last += 5;
                out.push(last);
            }
            return out.slice(0, sc);
        }
        const g6 = _BASE_OPEN_MIDI_GUITAR6.slice();
        if (Number.isFinite(sc) && sc < 6 && sc >= 1) return g6.slice(0, sc);
        return g6;
    }

    function _midiToPitchLabel(midi) {
        const m = Math.round(midi);
        const octave = Math.floor(m / 12) - 1;
        const n = _NOTE_NAMES_SHARP[(m % 12 + 12) % 12];
        return n + octave;
    }

    /**
     * @param {number} nEffective string count clamped like nStr / resolveStringCount
     * @param {Record<string, unknown>} songInfo WS song_info blob (subset)
     */
    function _openStringPitchLabelsForTuning(bundle, songInfo, nEffective) {
        const n = Number.isFinite(nEffective) ? Math.min(Math.max(1, Math.trunc(nEffective)), MAX_RENDER_STRINGS) : resolveStringCount(bundle);
        let tuning = (songInfo && songInfo.tuning) || bundle.tuning;
        let cap = songInfo && songInfo.capo;
        cap = Number.isFinite(cap) ? cap : (Number.isFinite(bundle.capo) ? bundle.capo : 0);
        if (!Array.isArray(tuning)) tuning = [];

        const base = _baseOpenStringMidis(n, songInfo?.arrangement);
        const labels = [];
        for (let s = 0; s < n; s++) {
            const offRaw = tuning[s];
            const off = Number.isFinite(offRaw) ? offRaw : 0;
            const midi = (base[s] !== undefined ? base[s] : 40) + off + cap;
            labels.push(_midiToPitchLabel(midi));
        }
        return labels;
    }

    const STR_THICK = 0.25 * K;

    const S_BASE = 3 * K;
    const S_GAP = 4 * K;

    const AHEAD = 4.0;
    const BEHIND = 0.5;
    // How long a note/chord-frame stays renderable past the hit line while a
    // note-state provider (slopsmith#254) is attached. The provider's
    // hit/miss verdict is asynchronous — the engine-side verifier reports it
    // ~0.35-0.5 s after the line — so the default ~50 ms note linger /
    // ~0.48 s chord linger lapses before the tint can apply. Drives both
    // the outer-loop cull (ndVerdictT0) and the smart drawNote cull below.
    const NOTEDETECT_GEM_VERDICT_WINDOW = 0.75;
    // chDt threshold past the hit line at which the chord-frame scan
    // gives up on an arpeggio-style frame whose constituents never come
    // in. Must be < NOTEDETECT_GEM_VERDICT_WINDOW (the rim's draw life
    // in detect mode); placing it at 0.55 s leaves ~0.2 s of the visible
    // window for the latch to fire and skip subsequent scans.
    const _ND_UNMATCHED_LATCH_AFTER = 0.55;
    // Sample approach offsets dt in [0, AHEAD] into strips. Lane quads use
    // z = dZ(dt) + TS*BEHIND = TS*(BEHIND - dt), while notes use z = dZ(n.t-now).
    // So note hit line (z=0) aligns with dt=BEHIND, not dt=0. Chart time at
    // lane parameter dt is now + dt - BEHIND (same z as a note at that time).
    // Each strip’s <anchor> uses that chart time so the blue lane doesn’t
    // switch ~BEHIND seconds before the XML <anchor time="…"/>.
    const HWY_LANE_TIME_SLICES = 96;
    /** Odd columns (1st/3rd/…) darker teal; even columns brighter blue. */
    const HWY_LANE_STRIPE_ODD_HEX  = 0x3d739e;
    const HWY_LANE_STRIPE_EVEN_HEX = 0x62a5d8;
    /** Lane quad alpha: base + highwayIntensity * scale (readable on dark floor). */
    const HWY_LANE_STRIPE_OP_BASE = 0.12;
    const HWY_LANE_STRIPE_OP_INT  = 0.24;
    /** Note travel speed. Tuned to Rocksmith's default note feel via play tests (PR #303). */
    const TS = 130 * K;
    /** Match `nextNoteByString` onset to this note (float + chart rounding; avoids ghost / glow flicker). */
    const NEXT_ON_STRING_T_EPS = 0.06;
    /**
     * 3D highway post-strum tail — chord frame + ghost fret digit share the same
     * hold and fade so timing stays consistent.
     */
    const CHORD_HWY_LINGER_S = 0.48;
    /** Linear fade at end of `CHORD_HWY_LINGER_S` (applies to chord UI and board ghost numbers). */
    const CHORD_HWY_FADE_S = 0.32;
    const GHOST_HOLD_AFTER_ONSET = CHORD_HWY_LINGER_S;
    const GHOST_FRET_LBL_FADE_S = CHORD_HWY_FADE_S;
    /** Purple lane rails: extend past last matched chord/note so Z reaches frame end. */
    const ARP_HWY_RAIL_END_TAIL_S = 0.38;
    /** Keep 0 — chord/note-based ``shapeLo`` already aligns to the visible frame. */
    const ARP_HWY_RAIL_START_LEAD_S = 0;
    /** Drives emissive (`mGlow` / accent fill) for notes with `.ac`; matches drawNote `linger` cutoff (0.05). */
    const ACCENT_NOTE_STR_GLOW = 3.55;
    const ACCENT_NOTE_LINGER_EPS = 0.05;
    /** Extra emissive layered on accent-only body material (`mAccentCore`), after `strGlow * glowMul`. */
    const ACCENT_NOTE_FILL_BOOST = 2.55;
    /** Accent rim draws brighter than normal string-coloured outlines (`mStrHitOutline`). */
    const ACCENT_RIM_BASE_EMISSIVE = 3.45;
    /** Outline / core scale bump vs normal gems (accent reads slightly larger). */
    const ACCENT_RIM_XY_SCALE_MUL = 1.09;
    const ACCENT_RIM_Z_SCALE_MUL = 1.06;
    // Soft neon-style outer bloom (AdditiveBlending) — layered shells behind outline/core.
    const ACCENT_HALO_OP_NEAR = 0.68;
    const ACCENT_HALO_OP_MID = 0.42;
    const ACCENT_HALO_OP_FAR = 0.24;
    const ACCENT_HALO_XY_INNER = 1.36;
    const ACCENT_HALO_XY_MID = 1.82;
    const ACCENT_HALO_XY_OUTER = 2.32;
    const ACCENT_HALO_Z_INNER = 1.05;
    const ACCENT_HALO_Z_MID = 1.12;
    const ACCENT_HALO_Z_OUTER = 1.22;

    /**
     * Post-hit tail fade shared by ghost fret digits and 3D chord UI: full
     * opacity until (holdS − fadeS) after onset, then linear fade over fadeS;
     * canceled when `nextSoon` — for ghosts: next note within `fadeS` of `now`;
     * for chord frame: next chord onset lies in chart time [hold − fade, hold]
     * after the current chord (so fade does not run into a same-window handoff).
     * @param {number} dt chart time minus now (negative once struck)
     * @param {number} fadeS linear fade duration (default: GHOST_FRET_LBL_FADE_S)
     */
    function hwyPostHitTailFadeMul(dt, holdS, nextSoon, fadeS = GHOST_FRET_LBL_FADE_S) {
        if (nextSoon || dt >= 0) return 1;
        const gone = -dt;
        if (gone >= holdS) return 0;
        const fS = Math.min(Math.max(fadeS, 1e-6), holdS);
        const fadeStartT = Math.max(0, holdS - fS);
        if (gone < fadeStartT) return 1;
        return Math.max(0, 1 - (gone - fadeStartT) / fS);
    }

    // Shorter, flatter notes (joel style)
    const NW = 5 * K, NH = 3 * K, ND = 0.5 * K;
    // Sustain-trail X offset for fretted notes. Module-scoped + frozen
    // so the hot path's `offsets.length` loop sees a stable singleton
    // reference. The standalone-open-string path builds a fresh pair
    // each call because its offset magnitude depends on the per-note
    // `openWScale` (set in drawNote at line 7367 from the open-string
    // body's lane width), so a module-scoped constant can't capture
    // it; the allocation is the same one the prior code did via
    // `const baseOff = NW * 3 * openWScale` plus the inline `[-, +]`
    // literal in the chord-member branch — just consolidated.
    const SINGLE_SUS_OFFSETS = Object.freeze([0]);
    const BEND_HALFSTEP_WORLD_Y = S_GAP * 0.8;
    const VIBRATO_HALF_WAVE_S = 0.08;
    // Bend ribbon envelope: fraction of the sustain spent ramping up to
    // the bent pitch, and releasing back down (rest is the held plateau).
    const BEND_ENV_RISE_FRAC = 0.35;
    const BEND_ENV_RELEASE_FRAC = 0.30;
    const TREMOLO_BUMP_S = 0.06;

    /** Longitudinal samples for sustain-technique prism (indexed BufferGeometry). */
    const SLIDE_RIBBON_SAMPLES = 96;
    /** Pre-built index buffer: `SLIDE_RIBBON_SAMPLES` × 8 tris × 3 verts. */
    const SLIDE_RIBBON_INDICES = (() => {
        const S = SLIDE_RIBBON_SAMPLES;
        const idx = new Uint16Array(S * 24);
        let o = 0;
        for (let k = 0; k < S; k++) {
            const b = k * 4;
            const nx = (k + 1) * 4;
            // Bottom (-Y outward)
            idx[o++] = b; idx[o++] = b + 1; idx[o++] = nx + 1;
            idx[o++] = b; idx[o++] = nx + 1; idx[o++] = nx;
            // Top (+Y outward)
            idx[o++] = b + 3; idx[o++] = nx + 3; idx[o++] = nx + 2;
            idx[o++] = b + 3; idx[o++] = nx + 2; idx[o++] = b + 2;
            // Left (-X outward)
            idx[o++] = b; idx[o++] = nx; idx[o++] = nx + 3;
            idx[o++] = b; idx[o++] = nx + 3; idx[o++] = b + 3;
            // Right (+X outward)
            idx[o++] = b + 1; idx[o++] = b + 2; idx[o++] = nx + 2;
            idx[o++] = b + 1; idx[o++] = nx + 2; idx[o++] = nx + 1;
        }
        return idx;
    })();
    // Three r170's setIndex() only wraps plain Arrays into Uint16BufferAttribute;
    // typed-array input gets assigned raw onto .index, which trips WebGL's
    // byteLength check. Convert once at module init so each pooled geometry
    // reuses the same Array reference instead of allocating per mesh.
    const SLIDE_RIBBON_INDICES_ARR = Array.from(SLIDE_RIBBON_INDICES);
    const N_RAD = 1.5 * K;
    const SW = 2 * K, SH = 1.5 * K;

    const CAM_H_BASE = 150 * K;
    const CAM_DIST_BASE = 240 * K;
    const REF_ASPECT = 16 / 9;
    const FOCUS_D = 600 * K;
    const CAM_LERP_BASE = 0.02;

    // Camera-X targeting (issue #34). The visible AHEAD = 4.0 s window is
    // far too coarse for picking where the camera should sit — a single
    // 17th-fret bend 2.5 s away yanks tgtX several frets even though the
    // immediate playing area hasn't moved. These constants are bounds for
    // a smoothing dial (0 = twitchy, 1 = calm); the runtime lerps between
    // the pair using the user's `cameraSmoothing` setting.
    const CAM_TGT_BEHIND   = 0.2;   // s behind hit line for X targeting
    const CAM_TGT_AHEAD_T  = 2.0;   // s — twitchy: longer lookahead (more reactive)
    const CAM_TGT_AHEAD_C  = 0.7;   // s — calm: shorter lookahead (ignore distant outliers)
    const CAM_TGT_TAU_T    = 0.35;  // s — twitchy: short recency time-constant
    const CAM_TGT_TAU_C    = 0.9;   // s — calm: longer time-constant (averages more)
    const CAM_TGT_HYST_T   = 0.25;  // frets — twitchy: tiny dead zone
    const CAM_TGT_HYST_C   = 5.0;   // frets — calm: ~5-fret dead zone, wide
                                    // enough to swallow chord-to-chord
                                    // alternations across a 6-fret span
                                    // (e.g. Am ↔ D in first position).

    // Zoom (tgtDist) damping. Controlled by its own `zoomSmoothing` setting
    // so X-pan and zoom-pull-back can be tuned independently. New users
    // (and existing users who never wrote zoomSmoothing) inherit
    // cameraSmoothing's value on first read, so default behaviour is
    // unchanged from when zoom + X shared a single slider.
    const CAM_DIST_HYST_T  = 0.5;   // fret-span — twitchy: minimal dead zone
    const CAM_DIST_HYST_C  = 5.0;   // fret-span — calm: 5-fret span change required

    // Vertical-tilt damping. Drives the tgtLookY self-correction loop in
    // camUpdate(): how far the fretboard's NDC Y can drift from
    // DESIRED_NDC_Y before we nudge the camera, and how strongly each
    // nudge corrects. Twitchy = narrow band + strong correction (re-frame
    // aggressively); calm = wide band + weak correction (let small drift
    // ride). Driven by `tiltSmoothing`, mirrors cameraSmoothing on first
    // read like zoomSmoothing does.
    // Bounds chosen so the midpoint (tiltSmoothing=0.5) reproduces the
    // pre-PR hardcoded behaviour (band=0.15, str=0.5). Without that, a
    // fresh install would silently change the vertical-tilt feel even
    // though the PR description promises "default behaviour unchanged."
    const CAM_TILT_BAND_T  = 0.05;  // NDC — twitchy: narrow tolerance
    const CAM_TILT_BAND_C  = 0.25;  // NDC — calm: wide tolerance, fewer corrections
    const CAM_TILT_STR_T   = 0.8;   // multiplier — twitchy: strong nudge per correction
    const CAM_TILT_STR_C   = 0.2;   // multiplier — calm: weak nudge per correction

    // Lock-low zoom range. The cameraLockZoom slider (0..1) blends between
    // these two multipliers and scales the locked tgtDist. Defaults pick
    // 1.0× at slider=0.5 so the previous locked view is the midpoint.
    const CAM_LOCK_ZOOM_MIN = 0.55;  // slider=0 — closest, biggest fretboard
    const CAM_LOCK_ZOOM_MAX = 1.45;  // slider=1 — furthest
    const CAM_LOCK_CENTER_FRET = 6;  // default camera X center (first-position midpoint)

    // ── 3D preview: lookahead fret bounds + smoothed focal X / span ─────────
    /** User-selectable via `cameraMode`. Legacy `classic` in storage maps to `steady`. */
    const CAMERA_MODE_IDS = ['steady', 'lookahead'];
    const CAM_LOOKAHEAD_SEC = 3.0;
    const CAM_FOCUS_BLEND_RATE = 0.7;
    const CAM_FRET_EDGE_BLEND = 0.1;
    const DEFAULT_LOOKAHEAD_FRET_SPAN = 4;
    /** Schmitt: avoid lock↔dynamic flicker when lookahead maxF jitters at the 12th fret. */
    const LOOKAHEAD_LOCK_RELEASE_MAXF = 13;
    const LOOKAHEAD_LOCK_ENGAGE_MAXF = 10;

    // Note: we deliberately do NOT scale the camUpdate lerp speed with
    // cameraSmoothing. Smoothing widens the hysteresis dead zones so the
    // camera stays put through small/repetitive shifts; but when a shift
    // *does* clear the gate (a real jump to a far fret), we want the slide
    // to be snappy, not lethargic. The dead zone gates "should we move?",
    // the BPM-scaled lerp answers "how fast" — keeping those orthogonal
    // gives the right feel.

    const FOG_START = 200 * K;
    const FOG_END = 670 * K;

    const DOTS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS = new Set([12, 24]);
    const INLAY_LABEL_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 22, 24]; // 22 not 21: intentional display choice

    // Fret-column reference markers: floor-aligned fret-number sprites
    // that scroll toward the hit line every Nth measure. When the chart
    // has <anchor>, the row uses the inlay cadence (DOTS) around the
    // anchor fret: two marker positions before and three after the
    // snapped cadence cell (e.g. anchor fret 7 → 3,5,7,9,12,15).
    const FRET_COL_MARKER_ANCHOR_BACK = 2;
    const FRET_COL_MARKER_ANCHOR_FWD = 3;

    /**
     * @param {number} anchorFret Chart anchor `.fret` (world start fret).
     * @param {number[]} [cadence] Ascending frets (e.g. DOTS).
     * @returns {number[]}
     */
    function fretColumnMarkersForAnchor(anchorFret, cadence = DOTS) {
        const f0 = Math.round(Number(anchorFret));
        if (!Number.isFinite(f0) || cadence.length === 0) return cadence.slice();
        let iBest = 0;
        let dBest = Infinity;
        for (let i = 0; i < cadence.length; i++) {
            const d = Math.abs(cadence[i] - f0);
            if (d < dBest || (d === dBest && cadence[i] < cadence[iBest])) {
                dBest = d;
                iBest = i;
            }
        }
        const i0 = Math.max(0, iBest - FRET_COL_MARKER_ANCHOR_BACK);
        const i1 = Math.min(cadence.length, iBest + FRET_COL_MARKER_ANCHOR_FWD + 1);
        return cadence.slice(i0, i1);
    }

    // Binary lower-bound: returns the first index i in arr where arr[i].t >= t.
    // Assumes arr is sorted ascending by .t (bundle.notes / bundle.chords always are).
    function lowerBoundT(arr, t) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Last arrangement <anchor> at or before chart time `t` (sorted by .time).
    // Mirrors static/highway.js getAnchorAt — until t reaches the first anchor’s
    // time, the first anchor still defines fret/width.
    // Binary search: this is called inside per-frame loops (lane slicing,
    // lookahead sampling, marker spawning), so the linear scan was O(samples *
    // numAnchors) on dense charts.
    function getChartAnchorAt(anchorArr, t) {
        if (!anchorArr || !anchorArr.length) return null;
        let lo = 0, hi = anchorArr.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (anchorArr[mid].time <= t) lo = mid + 1;
            else hi = mid;
        }
        return lo === 0 ? anchorArr[0] : anchorArr[lo - 1];
    }

    /** @returns {{ dMin: number, dMax: number } | null} */
    function laneBoundsFromAnchor(anc) {
        if (!anc) return null;
        let fStart = Math.round(Number(anc.fret));
        // Match anchorPlayedFretInclusiveSpan(): fret 0 (and below) clamps
        // to 1, otherwise the lane span ends up one fret narrower than the
        // played-fret span / label highlighting on charts that emit
        // <anchor fret="0" width="N">.
        if (!Number.isFinite(fStart) || fStart < 1) fStart = 1;
        let w = Number(anc.width);
        if (!Number.isFinite(w)) w = 4;
        w = Math.max(1, Math.round(w));
        const fLast = Math.min(NFRETS, fStart + w - 1);
        const dMin = Math.max(0, fStart - 1);
        const dMax = Math.min(NFRETS, fLast);
        return { dMin, dMax };
    }

    /** Same horizontal span as the dynamic highway lane: anchor at chart time `t`. */
    function anchorLaneBoundsAt(anchorArr, t) {
        if (!anchorArr || !anchorArr.length) return null;
        return laneBoundsFromAnchor(getChartAnchorAt(anchorArr, t));
    }

    /**
     * Inclusive chart-fret indices for the playing window (anchor `fret` + `width`),
     * e.g. fret=5 width=4 → 5..8. Unlike {@link laneBoundsFromAnchor}'s `dMin`/`dMax`
     * (diagram wire span), these are the labels shown on gems / row numbers.
     * @returns {{ f0: number, f1: number } | null}
     */
    function anchorPlayedFretInclusiveSpan(anc) {
        if (!anc) return null;
        let f0 = Math.round(Number(anc.fret));
        if (!Number.isFinite(f0) || f0 < 1) f0 = 1;
        let w = Number(anc.width);
        if (!Number.isFinite(w)) w = 4;
        w = Math.max(1, Math.round(w));
        const f1 = Math.min(NFRETS, f0 + w - 1);
        return { f0, f1 };
    }

    function anchorPlayedFretSpanAt(anchorArr, t) {
        if (!anchorArr || !anchorArr.length) return null;
        return anchorPlayedFretInclusiveSpan(getChartAnchorAt(anchorArr, t));
    }

    const FRET_COOLDOWN = 0.5; // seconds a lane fret stays active after last note

    const DIAG_LINGER_S    = 0.55;
    const DIAG_ENTRANCE_S  = 0.20;
    const DIAG_CROSSFADE_S = 0.15;
    const DIAG_SIZE_MIN    = 0.08;
    const DIAG_SIZE_MAX    = 0.16;
    const DIAG_CELL_MAX    = 34;
    const CHORD_DIAG_POSITION_IDS = ['tl', 'tr', 'bl', 'br'];

    /** Default chord-box rim / fill gradient (teal family). */
    const CHORD_BOX_TEAL_HEX = 0x00d2d5;
    const CHORD_BOX_TEAL_DARK_HEX = 0x003c3d;
    /** Frame edge quads: premultiplied-ish alpha match (~128/255). */
    const CHORD_BOX_EDGE_ALPHA = 128 / 255;
    /** Interior gradient strip alpha on both stops (~32/255). */
    const CHORD_BOX_FILL_GRAD_ALPHA = 32 / 255;
    /** Arpeggio interior wash; dedicated gradient tex so teal map doesn’t dominate. */
    const ARPEGGIO_BOX_BLUE_HEX = 0x454BB6;
    const ARPEGGIO_BOX_BLUE_DARK_HEX = 0x2D3190;
    /** Arpeggio rim accent and lane tint. */
    const ARPEGGIO_RIM_BLUE_HEX = 0x454BB6;
    /** Post-hit chord-frame rim tints driven by the note-state provider
     *  (slopsmith#254). Applied only to the teal frame during the linger
     *  fade (chDt <= 0) when a scorer is attached. */
    const CHORD_BOX_HIT_HEX = 0x40e060;
    const CHORD_BOX_MISS_HEX = 0xe04040;

    /** Fret-number label tints — gold on approaching/active notes, muted blue when idle. */
    const FRET_LABEL_GOLD_HEX = '#D8A636';
    const FRET_LABEL_IDLE_HEX = '#9ab8cc';

    /** 3D chord-box rim bars (thin on all chords, including repeats in a sequence). */
    const CHORD_FRAME_RIM_MIN = 0.055;       // × K — floor thickness
    const CHORD_FRAME_RIM_FRAC_H = 0.028;    // × fullChordBoxH
    const CHORD_FRAME_RIM_Z_MIN = 0.048;      // × K — depth squash
    const CHORD_FRAME_RIM_Z_SCAL = 0.68;     // thickZ scales with ft
    /**
     * Highway arpeggio frame uses ``inferArpeggioFromNotePattern`` only inside this
     * window around ``ch.t``. Hand-shape spans can cover many seconds and several
     * separate strums of the same voicing; a full-span scan mis-detects arpeggio
     * from beats that belong to different chord rows.
     */
    const ARP_FRAME_ONSET_PAD_S = 0.06;
    const ARP_FRAME_ONSET_CLUSTER_S = 0.26;
    /**
     * Rocksmith encodes fast alternating power chords (e.g. D5/D#5 gallops) as
     * very short ``<handShape>`` rows (~0.05–0.2 s). Note-stream arpeggio
     * inference must not treat strum spread across strings as arpeggio there —
     * it false-triggers lavender highway rails / frames (see Frantic ~2:36).
     */
    const ARP_INFER_MIN_HAND_SHAPE_SPAN_S = 0.21;
    /**
     * In a **short** chart window, chord strums (same voicing, strings picked
     * within ~30–45 ms) barely exceed this total spread; real arpeggios in that
     * window are usually slower across strings OR have 4+ plucks.
     */
    const ARP_INFER_STRUM_VS_ARP_SPREAD_MIN_S = 0.047;
    /**
     * If more than ``shape.size + ARP_INFER_MULTI_STRUM_HIT_SLACKS`` matching picks
     * sit inside a non-trivial hand-shape window, the chart is almost certainly
     * **repeated strums** of the same chord (or gallops), not one arpeggio sweep.
     */
    const ARP_INFER_MULTI_STRUM_HIT_SLACK = 2;
    /** ``timeWin`` span above which we apply the multi-strum hit-count cap. */
    const ARP_INFER_MULTI_STRUM_WIN_MIN_S = 0.26;
    /**
     * Minimum staggered hits inside a hand-shape window for note-stream arpeggio
     * inference. A genuine arpeggio sweeps several strings of the held shape;
     * a 2-note melodic motif inside a multi-string ``<handShape>`` (e.g. Jackson 5
     * "I Want You Back" ~0:27 — Fm7 transition fingering with two plucks on
     * strings 4–5) earlier registered as arpeggio and produced a stray lavender
     * chord frame + purple lane outer dividers. Cap at ``min(shape.size, 3)``
     * so 2-string voicings still infer normally and 3+ string templates need
     * a real sweep.
     */
    const ARP_INFER_MIN_HITS_VS_SHAPE_CAP = 3;

    /* ======================================================================
     *  Pure helpers
     * ====================================================================== */

    // Logarithmic spacing — mirrors real guitar fret geometry (12th root of 2).
    const _fretXLog = f => {
        if (f <= 0) return 0;
        const raw = SCALE - SCALE / Math.pow(2, f / 12);
        if (f <= FRET_SPACING_ANCHOR_F) return raw;
        const rawAnchor = SCALE - SCALE / Math.pow(2, FRET_SPACING_ANCHOR_F / 12);
        return rawAnchor + (raw - rawAnchor) * FRET_SPACING_STRETCH_ABOVE12;
    };
    // Uniform spacing — same column width per fret (Rocksmith Remastered style).
    // Total board width equals the logarithmic NFRETS position for consistency.
    const _fretXUniStep = _fretXLog(NFRETS) / NFRETS;
    const _fretXUni = f => f <= 0 ? 0 : f * _fretXUniStep;

    let _h3dFretUniform = true;
    try { _h3dFretUniform = localStorage.getItem('highway_3d.fretSpacing') !== 'logarithmic'; } catch (_) {}
    const fretX = f => _h3dFretUniform ? _fretXUni(f) : _fretXLog(f);

    window.h3dSetFretSpacing = mode => {
        // Validate against the two supported modes before persisting so an
        // unexpected input can't leave an invalid value in localStorage
        // (mirrors h3dBgSetFretNumberGhostScope's allowlist guard). No-op
        // when the stored mode is already what was requested.
        const m = mode === 'logarithmic' ? 'logarithmic' : 'uniform';
        try {
            if (localStorage.getItem('highway_3d.fretSpacing') === m) return;
            localStorage.setItem('highway_3d.fretSpacing', m);
        } catch (_) {}
        location.reload();
    };

    const fretMid = f => (f <= 0 ? -2 * K : (fretX(f - 1) + fretX(f)) / 2);
    /** World-space width of fret column (wires f−1 .. f); used to scale row markers past ~12. */
    function fretColumnWorldW(f) {
        const fi = Math.round(Number(f));
        if (!Number.isFinite(fi) || fi <= 0) return Math.abs(fretX(1) - fretX(0));
        const lo = Math.min(NFRETS, Math.max(1, fi));
        return Math.abs(fretX(lo) - fretX(lo - 1));
    }
    /** Reference column (~mid board): prior fixed K-based sprites matched this neighborhood. */
    const FRET_LABEL_SCALE_REF_FRET = 5;
    const _fretLabelScaleRefW = Math.max(1e-8, fretColumnWorldW(FRET_LABEL_SCALE_REF_FRET));
    function fretLabelScaleForFret(f) {
        const w = fretColumnWorldW(f);
        const m = w / _fretLabelScaleRefW;
        return Math.max(0.32, Math.min(1.45, m));
    }
    const dZ = dt => -dt * TS;

    /**
     * Pitched slide uses `sl`, unpitched uses `slu` (slide-to vs unpitched slide fields).
     * Prefer `sl` when both are present — matches RS wire.
     * @returns {{ endFret: number, unpitched: boolean } | null}
     */
    function slideTrailEnd(n) {
        const sl = n.sl;
        const slu = n.slu;
        if (Number.isFinite(sl) && sl >= 0) {
            return { endFret: sl | 0, unpitched: false };
        }
        if (Number.isFinite(slu) && slu >= 0) {
            return { endFret: slu | 0, unpitched: true };
        }
        return null;
    }

    /**
     * Lateral slide offset along the fretboard during sustain — easing
     * mirrors the pitched/unpitched slide offset convention above.
     * @param {{ endFret: number, unpitched: boolean } | null} [st_] from slideTrailEnd
     */
    function slideOffsetWorldX(n, chartTime, st_) {
        const st = st_ || slideTrailEnd(n);
        if (!st || n.f <= 0 || !(n.sus > 0)) return 0;
        const denom = Math.max(n.sus, 1e-6);
        const p = Math.max(0, Math.min(1, (chartTime - n.t) / denom));
        const startX = fretMid(n.f);
        const endX = fretMid(st.endFret);
        const w = st.unpitched
            ? 1 - Math.sin((1 - p) * Math.PI / 2)
            : Math.pow(Math.sin(p * Math.PI / 2), 3);
        return (endX - startX) * w;
    }

    // Camera tgtDist building blocks. Both the dynamic (camera-follow)
    // and locked (frets 1-12) branches compose tgtDist from these, so
    // any future tuning of the base zoom curve or low-fret pullback
    // lands in both branches without drift.
    //   span    — camDistMax - camDistMin in fret-span units
    //   minFret — lowest fretted note in the camera window (or 1 for
    //             the locked branch, which assumes nut chords)
    const camBaseDistU = span => 65 + Math.max(span, 4) * 3;
    const camLowFretPullbackU = minFret => Math.max(0, 5 - minFret) * 4;

    // World-units-per-fret near mid-neck. Used by the camera-X hysteresis
    // gate (issue #34) to convert a fret-equivalent dead zone into world
    // units. Pure function of SCALE — hoist out of update()'s hot path.
    const FRET_WIDTH_MID = fretX(7) - fretX(6);

    function computeBPM(beats, t) {
        if (!beats || beats.length < 2) return 120;
        let lo = 0, hi = beats.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid].time < t) lo = mid + 1; else hi = mid;
        }
        let closest = lo;
        if (lo === beats.length) closest = beats.length - 1;
        else if (lo > 0 && Math.abs(beats[lo - 1].time - t) < Math.abs(beats[lo].time - t)) closest = lo - 1;
        const start = Math.max(0, closest - 2);
        const end = Math.min(beats.length - 1, closest + 2);
        let sum = 0, count = 0;
        for (let i = start; i < end; i++) {
            const dt = beats[i + 1].time - beats[i].time;
            if (dt > 0) { sum += dt; count++; }
        }
        return count > 0 && sum > 0 ? 60 / (sum / count) : 120;
    }

    // Build a horizontal gaussian DataTexture for the sustain-rail bloom effect.
    // Returns a W×1 RGBA texture where alpha follows exp(-0.5*(u−0.5)²/σ²),
    // peaking at 1.0 in the centre. With the default σ=0.28 the edges retain
    // ~0.20 alpha (not fully transparent) — a deliberately soft, wide falloff
    // so the additive bloom fades gradually rather than cutting off sharply.
    // Power-of-two width keeps WebGL mipmapping happy.
    function _makeGaussTex(ThreeLib, w = 128, sigma = 0.28) {
        const data = new Uint8Array(w * 4);
        for (let i = 0; i < w; i++) {
            const u = i / (w - 1);
            const d = (u - 0.5) / sigma;
            const v = Math.exp(-0.5 * d * d);
            const a = Math.round(v * 255);
            data[i * 4]     = 255;
            data[i * 4 + 1] = 255;
            data[i * 4 + 2] = 255;
            data[i * 4 + 3] = a;
        }
        const tex = new ThreeLib.DataTexture(data, w, 1, ThreeLib.RGBAFormat);
        // LinearFilter on both axes so the bloom plane interpolates smoothly
        // when scaled — the default NearestFilter causes visible banding.
        tex.magFilter = ThreeLib.LinearFilter;
        tex.minFilter = ThreeLib.LinearFilter;
        tex.needsUpdate = true;
        return tex;
    }

    /* ======================================================================
     *  Three.js module — lazily loaded, memoized
     * ====================================================================== */

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(e => {
                        console.error('[3D-Hwy] Three.js load failed:', e);
                        threeLoadPromise = null;
                        throw e;
                    }));
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Splitscreen helpers
     * ====================================================================== */

    function _ssActive() {
        const ss = window.slopsmithSplitscreen;
        if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
        return typeof ss.isCanvasFocused === 'function'
            && typeof ss.onFocusChange === 'function'
            && typeof ss.offFocusChange === 'function';
    }

    function _ssIsCanvasFocused(highwayCanvas) {
        const ss = window.slopsmithSplitscreen;
        if (!_ssActive()) return true;
        return !!(ss && typeof ss.isCanvasFocused === 'function' &&
            ss.isCanvasFocused(highwayCanvas));
    }

    /* ======================================================================
     *  Background animations (issue #13)
     *
     *  Audio-reactive ambient scenery in the fog band beyond the highway.
     *  Module-level singletons share an AudioContext + AnalyserNode tap on
     *  the slopsmith core <audio id="audio"> element across all panel
     *  instances; per-panel settings live in localStorage with a global
     *  fallback so settings.html drives a single default while per-panel
     *  overrides (h3d_bg_panel<idx>_*) can be set for splitscreen layouts.
     *
     *  Caveat: createMediaElementSource() can only be called once per
     *  element. 3dhighway owns that source for now; future plugins
     *  needing an analyser will have to share through a core API.
     * ====================================================================== */

    // Returned from _bgReadBands when reactive=false or analyser
    // unavailable; shared so the per-frame non-reactive path doesn't
    // allocate. Declared up-front because _bgBandsCache initializes to
    // it during the same IIFE execution pass.
    const BG_ZERO_BANDS = Object.freeze({ bass: 0, mid: 0, treble: 0 });

    // Module-level AudioContext singleton. Intentionally never torn
    // down: createMediaElementSource(<audio>) is irrevocable — once
    // called, the element's audio is permanently routed through this
    // context for the page's lifetime. Closing the context would
    // silence playback. The leak (one AudioContext + one AnalyserNode,
    // a few KB) is the cost of having a plugin tap audio at all.
    let _bgAudio = null;
    // The core (#audio-tap) cache is held separately from the stems cache so
    // we can switch back to it without re-calling createMediaElementSource on
    // #audio — that call is one-shot per element, and a second one throws
    // InvalidStateError (which would then be marked permanent and disable
    // reactivity forever on PSARC songs after any sloppak detour).
    let _bgAudioCore = null;
    let _bgAudioFailedAt = 0;  // performance.now() of last failure, 0 = never
    const _BG_AUDIO_RETRY_MS = 1000;
    // _bgReadBands sums bins 0..7 (bass), 8..39 (mid), 40..127 (treble),
    // so the frequency buffer must hold at least 128 bins regardless of
    // the source analyser's fftSize.
    const BG_FREQ_BINS = 128;
    function _bgGetAnalyser() {
        // Prefer the stems plugin's side-chain analyser when a sloppak is
        // loaded. As of slopsmith-plugin-stems 0.5.0 (sample-locked playback)
        // the #audio element is a silent virtual transport on sloppaks, so
        // tapping it sees only silence; the stems mix is exposed at
        // window.slopsmith.stems.getAnalyser() instead. The stems plugin
        // creates and destroys that AnalyserNode per song, so we re-check
        // each call and key the cache on its identity — when the node
        // changes (song switch), the cache is replaced automatically.
        const stemsApi = window.slopsmith && window.slopsmith.stems;
        const stemsAnalyser = (stemsApi && typeof stemsApi.getAnalyser === 'function')
            ? stemsApi.getAnalyser() : null;
        if (stemsAnalyser) {
            if (!_bgAudio || _bgAudio.source !== 'stems' || _bgAudio.analyser !== stemsAnalyser) {
                // Adopt the live stems analyser. Do NOT close its context — it's
                // shared with stem playback and the stems plugin owns its
                // lifecycle. No play-event resume hooks either; the stems
                // plugin manages context resume itself.
                _bgAudio = {
                    ctx: stemsAnalyser.context,
                    analyser: stemsAnalyser,
                    // _bgReadBands reads bins 0..127 unconditionally. Always
                    // allocate at least 128 bytes so a smaller analyser (e.g.
                    // fftSize < 256) can't leave undefined values in the loop.
                    freq: new Uint8Array(Math.max(BG_FREQ_BINS, stemsAnalyser.frequencyBinCount)),
                    source: 'stems',
                };
            }
            return _bgAudio;
        }
        // No sloppak active — drop a stale stems-sourced cache, restoring the
        // core-tap cache if we'd already built one. Without this, the next
        // step would try to createMediaElementSource(#audio) a second time
        // (one-shot per element) and throw InvalidStateError — disabling
        // reactivity for the rest of the page lifetime.
        if (_bgAudio && _bgAudio.source === 'stems') _bgAudio = _bgAudioCore;

        if (_bgAudio && !_bgAudio.failed) return _bgAudio;
        if (_bgAudio && _bgAudio.failed) {
            // Distinguish permanent failures from transient ones.
            // InvalidStateError on createMediaElementSource means the
            // <audio> element is already tapped by another consumer —
            // there's no recovering from that without a page reload, so
            // don't retry. Transient failures (NotAllowedError before
            // first user gesture, etc.) get a once-per-second retry so
            // reactivity recovers once the blocking condition clears.
            if (_bgAudio.permanent) return null;
            if (performance.now() - _bgAudioFailedAt < _BG_AUDIO_RETRY_MS) return null;
        }
        const audio = document.getElementById('audio');
        if (!audio) return null;
        // Hoist ctx out of the try so we can close() it if a later step
        // throws (e.g. createMediaElementSource on an element that
        // already has a source node). Otherwise the AudioContext leaks.
        let ctx = null;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error('Web Audio API not available');
            ctx = new Ctx();
            const source = ctx.createMediaElementSource(audio);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(ctx.destination);
            _bgAudio = { ctx, analyser, freq: new Uint8Array(Math.max(BG_FREQ_BINS, analyser.frequencyBinCount)), source: 'core' };
            // Remember the core analyser so a later stems-then-back-to-core
            // transition can re-use it instead of re-tapping #audio (which
            // would throw InvalidStateError on the one-shot per element).
            _bgAudioCore = _bgAudio;
            // Browsers with autoplay restrictions hand back a suspended
            // AudioContext; createMediaElementSource then routes the
            // <audio> through that suspended graph and playback goes
            // silent (and the analyser reads zeros) until we resume.
            // Try once now (fine if the page already had a user gesture)
            // and again on every play event so the first successful
            // user-initiated play unblocks the graph.
            const resume = () => {
                if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                    ctx.resume().catch(() => { /* no gesture yet, retry on next play */ });
                }
            };
            resume();
            audio.addEventListener('play', resume);
            return _bgAudio;
        } catch (e) {
            if (ctx && typeof ctx.close === 'function') {
                try { ctx.close(); } catch (_) { /* close errors during failure path are noise */ }
            }
            console.warn('[3D-Hwy] failed to set up audio analyser:', e);
            const permanent = !!(e && e.name === 'InvalidStateError');
            _bgAudio = { failed: true, permanent };
            _bgAudioFailedAt = performance.now();
            return null;
        }
    }

    // Bands cache: in splitscreen, every panel asks for bands per frame.
    // The analyser is shared, so the answer is identical — cache for a
    // few ms so 4-up splitscreen pays one getByteFrequencyData + one sum
    // pass per frame instead of four.
    const _BG_BANDS_CACHE_MS = 5;
    let _bgBandsLastT = -Infinity;
    // Mutable cache reused across reads — refreshing in place keeps the
    // per-frame allocation count at zero. Style.update() uses the bands
    // synchronously within the same frame so the live-mutation contract
    // is safe.
    const _bgBandsCache = { bass: 0, mid: 0, treble: 0 };
    function _bgReadBands() {
        const a = _bgGetAnalyser();
        if (!a) return BG_ZERO_BANDS;
        const t = performance.now();
        if (t - _bgBandsLastT < _BG_BANDS_CACHE_MS) return _bgBandsCache;
        _bgBandsLastT = t;
        a.analyser.getByteFrequencyData(a.freq);
        let bass = 0, mid = 0, treble = 0;
        for (let i = 0; i < 8; i++) bass += a.freq[i];
        for (let i = 8; i < 40; i++) mid += a.freq[i];
        for (let i = 40; i < 128; i++) treble += a.freq[i];
        _bgBandsCache.bass = bass / (8 * 255);
        _bgBandsCache.mid = mid / (32 * 255);
        _bgBandsCache.treble = treble / (88 * 255);
        return _bgBandsCache;
    }

    const BG_DEFAULTS = { style: 'particles', intensity: 0.5, reactive: true, palette: 'default', showFretOnNote: true, fretNumberGhostScope: 'rocksmith', cameraSmoothing: 0.5, zoomSmoothing: 0.5, tiltSmoothing: 0.5, cameraLockLow: false, cameraLockZoom: 0.5, cameraMode: 'lookahead', nutHeadstockVisible: true, tuningLabelsVisible: true, nutColor: '#f5f3f0', headstockColor: '#d4b48a', textSize: 0.5, vibrancy: 0.85, glow: 0.25, customImageDataUrl: '', customImageName: '', customVideoName: '', chordDiagramSize: 0.5, chordDiagramPosition: 'tl', fretColumnMarkerCadence: 1, projectionVisible: true, inlayLabelsVisible: false, sectionLabelsOnHighway: false, sectionHudVisible: true, sectionHudPosition: 'tr', sectionHudSize: 0.5 };
    const BG_STYLE_IDS = ['off', 'particles', 'silhouettes', 'lights', 'geometric', 'image', 'video'];
    const FRET_NUMBER_GHOST_SCOPE_IDS = ['rocksmith', 'all'];

    function _bgPanelKey(canvas) {
        const ss = window.slopsmithSplitscreen;
        const idx = (ss && typeof ss.panelIndexFor === 'function') ? ss.panelIndexFor(canvas) : null;
        return (idx == null) ? 'main' : 'panel' + idx;
    }
    // In-memory fallback for when localStorage is blocked (private mode,
    // sandboxed iframes, some test runners). _bgWriteGlobal stages the
    // value here unconditionally, so it always reflects the most recent
    // in-session intent — _bgReadSetting prefers it over the global
    // localStorage slot to avoid serving a stale persisted value when
    // a write failed silently (quota exceeded, etc.). Per-panel
    // localStorage overrides still win because they're an explicit
    // per-instance opt-out and shouldn't be shadowed by a global edit.
    const _bgMemFallback = Object.create(null);
    function _bgReadSetting(panelKey, key) {
        let panelVal = null;
        let globalVal = null;
        try {
            panelVal = localStorage.getItem('h3d_bg_' + panelKey + '_' + key);
            globalVal = localStorage.getItem('h3d_bg_' + key);
        } catch (_) { /* storage blocked — both stay null */ }
        if (panelVal !== null && panelVal !== undefined) return _bgCoerce(key, panelVal);
        // Prefer the in-memory staged value over the persisted global slot.
        // _bgWriteGlobal always writes to _bgMemFallback first, so the
        // memory value is at least as fresh as the persisted one.
        if (key in _bgMemFallback) return _bgCoerce(key, _bgMemFallback[key]);
        if (globalVal !== null && globalVal !== undefined) return _bgCoerce(key, globalVal);
        return BG_DEFAULTS[key];
    }
    // Shared "stored string -> bool" coercion for every boolean
    // setting. Mirrors settings.html's coerceBool so the renderer and
    // the UI hydration always agree on what a corrupted/unknown value
    // means (fall back to default rather than silently flipping to
    // false). Add new boolean keys to BG_DEFAULTS and they pick this
    // up via the dispatch below.
    const _BG_BOOL_KEYS = new Set(['reactive', 'showFretOnNote', 'cameraLockLow', 'inlayLabelsVisible', 'sectionLabelsOnHighway', 'sectionHudVisible', 'nutHeadstockVisible', 'tuningLabelsVisible', 'projectionVisible']);
    function _bgCoerceBool(val, fallback) {
        if (val === 'true' || val === '1') return true;
        if (val === 'false' || val === '0') return false;
        return fallback;
    }
    // Settings stored as 0..1 floats. cameraSmoothing controls X-pan
    // hysteresis; zoomSmoothing the zoom dead zone; tiltSmoothing the
    // vertical-tilt deadband + correction strength. All three slider-
    // shaped settings share the same parse + clamp behaviour.
    const _BG_FLOAT_KEYS = new Set(['intensity', 'cameraSmoothing', 'zoomSmoothing', 'tiltSmoothing', 'cameraLockZoom', 'textSize', 'vibrancy', 'glow', 'chordDiagramSize', 'sectionHudSize']);
    function _bgCoerce(key, val) {
        if (_BG_FLOAT_KEYS.has(key)) {
            const n = parseFloat(val);
            return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : BG_DEFAULTS[key];
        }
        if (_BG_BOOL_KEYS.has(key)) return _bgCoerceBool(val, BG_DEFAULTS[key]);
        if (key === 'style') return BG_STYLE_IDS.includes(val) ? val : BG_DEFAULTS.style;
        if (key === 'palette') return PALETTE_IDS.includes(val) ? val : BG_DEFAULTS.palette;
        if (key === 'chordDiagramPosition')
            return CHORD_DIAG_POSITION_IDS.includes(val) ? val : BG_DEFAULTS.chordDiagramPosition;
        if (key === 'sectionHudPosition')
            return CHORD_DIAG_POSITION_IDS.includes(val) ? val : BG_DEFAULTS.sectionHudPosition;
        if (key === 'cameraMode') {
            if (val === 'classic') val = 'steady';
            return CAMERA_MODE_IDS.includes(val) ? val : BG_DEFAULTS.cameraMode;
        }
        if (key === 'fretNumberGhostScope')
            return FRET_NUMBER_GHOST_SCOPE_IDS.includes(val) ? val : BG_DEFAULTS.fretNumberGhostScope;
        if (key === 'nutColor' || key === 'headstockColor') {
            if (typeof val !== 'string') return BG_DEFAULTS[key];
            const t = val.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
            return BG_DEFAULTS[key];
        }
        if (key === 'fretColumnMarkerCadence') {
            const n = parseInt(val, 10);
            if (!Number.isFinite(n)) return BG_DEFAULTS.fretColumnMarkerCadence;
            return Math.max(0, Math.min(16, n));
        }
        return val;
    }

    // Mirror-at-first-read fallback: returns true if the user has ever
    // explicitly written `key` (per-panel, in-memory, or global). When
    // false, callers should treat the value as "unset" — useful for
    // zoomSmoothing / tiltSmoothing which inherit cameraSmoothing's
    // value the first time they're read so existing users who calmed
    // the camera don't lose calmness on the new axes by default.
    function _bgHasStored(panelKey, key) {
        try {
            if (localStorage.getItem('h3d_bg_' + panelKey + '_' + key) != null) return true;
        } catch (_) {}
        if (key in _bgMemFallback) return true;
        try {
            if (localStorage.getItem('h3d_bg_' + key) != null) return true;
        } catch (_) {}
        return false;
    }
    function _bgWriteGlobal(key, val) {
        const s = String(val);
        // Stage in memory FIRST so _bgReadSetting's "memory beats global
        // localStorage" precedence has a true freshness guarantee even
        // if localStorage.setItem throws partway through. Without this
        // ordering, a quota exception thrown after the persisted slot
        // was already mutated would leave a stale value in localStorage
        // that's newer than _bgMemFallback.
        _bgMemFallback[key] = s;
        try { localStorage.setItem('h3d_bg_' + key, s); } catch (_) { /* storage blocked */ }
        _bgEmitChange(key);
    }

    // Pub-sub so settings.html can update live across all panel instances.
    const _bgListeners = new Set();
    function _bgSubscribe(fn) { _bgListeners.add(fn); }
    function _bgUnsubscribe(fn) { _bgListeners.delete(fn); }
    function _bgEmitChange(key) {
        for (const fn of _bgListeners) {
            try { fn(key); } catch (e) { console.error('[3D-Hwy] bg listener threw', e); }
        }
    }

    // Settings.html setters — global keys; per-panel overrides via direct
    // localStorage edits today, runtime UI in a follow-up.
    window.h3dBgSetStyle = (v) => _bgWriteGlobal('style', v);
    window.h3dBgSetIntensity = (v) => _bgWriteGlobal('intensity', v);
    window.h3dBgSetReactive = (v) => _bgWriteGlobal('reactive', !!v);
    window.h3dBgSetPalette = (v) => _bgWriteGlobal('palette', v);
    window.h3dBgSetShowFretOnNote = (v) => _bgWriteGlobal('showFretOnNote', !!v);
    window.h3dBgSetFretNumberGhostScope = (v) => {
        const s = String(v);
        _bgWriteGlobal('fretNumberGhostScope', FRET_NUMBER_GHOST_SCOPE_IDS.includes(s) ? s : BG_DEFAULTS.fretNumberGhostScope);
    };
    window.h3dBgSetCameraSmoothing = (v) => _bgWriteGlobal('cameraSmoothing', v);
    window.h3dBgSetZoomSmoothing = (v) => _bgWriteGlobal('zoomSmoothing', v);
    window.h3dBgSetTiltSmoothing = (v) => _bgWriteGlobal('tiltSmoothing', v);
    window.h3dBgSetCameraLockLow = (v) => _bgWriteGlobal('cameraLockLow', !!v);
    window.h3dBgSetCameraLockZoom = (v) => _bgWriteGlobal('cameraLockZoom', v);
    window.h3dBgSetCameraMode = (v) => {
        let s = String(v);
        if (s === 'classic') s = 'steady';
        _bgWriteGlobal('cameraMode', s);
    };
    window.h3dBgSetNutHeadstockVisible = (v) => _bgWriteGlobal('nutHeadstockVisible', !!v);
    window.h3dBgSetTuningLabelsVisible = (v) => _bgWriteGlobal('tuningLabelsVisible', !!v);
    window.h3dBgSetNutColor = (v) => _bgWriteGlobal('nutColor', v);
    window.h3dBgSetHeadstockColor = (v) => _bgWriteGlobal('headstockColor', v);
    window.h3dBgSetTextSize = (v) => _bgWriteGlobal('textSize', v);
    window.h3dBgSetVibrancy = (v) => _bgWriteGlobal('vibrancy', v);
    window.h3dBgSetGlow     = (v) => _bgWriteGlobal('glow', v);
    window.h3dBgSetChordDiagramSize     = (v) => _bgWriteGlobal('chordDiagramSize', v);
    window.h3dBgSetChordDiagramPosition = (v) => _bgWriteGlobal('chordDiagramPosition', v);
    window.h3dBgSetFretColumnMarkerCadence = (v) => _bgWriteGlobal('fretColumnMarkerCadence', v);
    window.h3dBgSetInlayLabelsVisible = (v) => _bgWriteGlobal('inlayLabelsVisible', !!v);
    window.h3dBgSetSectionLabelsOnHighway = (v) => _bgWriteGlobal('sectionLabelsOnHighway', !!v);
    window.h3dBgSetSectionHudVisible      = (v) => _bgWriteGlobal('sectionHudVisible', !!v);
    window.h3dBgSetSectionHudPosition     = (v) => _bgWriteGlobal('sectionHudPosition', v);
    window.h3dBgSetSectionHudSize         = (v) => _bgWriteGlobal('sectionHudSize', v);
    window.h3dBgSetProjectionVisible      = (v) => _bgWriteGlobal('projectionVisible', !!v);
    // Custom image asset for the 'image' bg style (#19). Composite setter:
    // writes both the data URL (the bytes that drive the texture) and the
    // display filename, each emitting a change event. The listener
    // rebuilds on customImageDataUrl change when the image style is
    // active; customImageName is display-only and skips rebuild.
    window.h3dBgSetCustomImage = (asset) => {
        const a = asset || {};
        _bgWriteGlobal('customImageDataUrl', a.dataUrl || '');
        _bgWriteGlobal('customImageName', a.name || '');
    };
    window.h3dBgClearCustomImage = () => {
        _bgWriteGlobal('customImageDataUrl', '');
        _bgWriteGlobal('customImageName', '');
    };
    // Custom video asset for the 'video' bg style (#19 follow-up).
    // Bytes live on disk under {config_dir}/plugin_uploads/highway_3d/
    // and are served by routes.py — localStorage only stores the
    // filename, which the renderer maps to the served URL. Single
    // global slot; the file picker in settings.html POSTs to the
    // upload route and then calls this setter with the response name.
    window.h3dBgSetCustomVideo = (asset) => {
        _bgWriteGlobal('customVideoName', (asset && asset.name) || '');
    };
    window.h3dBgClearCustomVideo = () => _bgWriteGlobal('customVideoName', '');
    // Back-compat alias for any caller that picked up the original
    // (inconsistent) name during this PR's review window.
    window.h3dSetPalette = window.h3dBgSetPalette;

    // Procedural silhouette bitmap, drawn once and shared across panels.
    // The Canvas2D bitmap is module-level (cheap, CPU-only); each layer
    // wraps it in its own CanvasTexture so per-layer texture.offset.x
    // can drive a seam-free scroll without coupling to other layers /
    // panels (a shared CanvasTexture would synchronize all offsets).
    let _silCanvas = null;
    function _bgEnsureSilhouetteCanvas() {
        if (_silCanvas) return _silCanvas;
        const c = document.createElement('canvas');
        c.width = 1024; c.height = 64;
        const cx = c.getContext('2d');
        if (!cx) {
            // Restrictive environments (some sandboxed iframes, headless
            // tests) can return null. Without a guard, the clearRect/
            // fillRect calls below would throw TypeError and the silhouette
            // style would never become available.
            throw new Error('[3D-Hwy] 2D canvas context unavailable for silhouette texture');
        }
        cx.clearRect(0, 0, c.width, c.height);
        cx.fillStyle = '#000814';
        let x = 0;
        while (x < c.width) {
            const w = 8 + Math.random() * 30;
            const h = 20 + Math.random() * 40;
            cx.fillRect(x, c.height - h, w, h);
            x += w + Math.random() * 10;
        }
        _silCanvas = c;
        return c;
    }

    // Helpers shared by the asset-driven bg styles (image, video).
    // Both render a "stage backdrop" plane that's full-bleed: sized
    // each frame to fill the camera's view frustum at a fixed
    // distance and positioned to track the camera (so the user's
    // image/video reads as the entire visible BG, with highway and
    // notes painting on top via renderOrder).
    //
    // Distance is chosen far enough back that no note ever lands
    // beyond it; depthWrite=false on the plane material plus
    // renderOrder=-1 means notes still paint on top regardless.
    const BG_BACKDROP_DISTANCE = FOG_END * 0.95;

    // Module-level scratch vector reused each frame to avoid GC
    // churn from per-frame Vector3 allocation. Only valid for the
    // duration of a single update() call.
    const _bgBackdropTmp = (() => {
        // Lazily created when T is available (T isn't bound at module
        // parse time — initScene assigns it inside loadThree().then).
        // Returning a getter that allocates on first read keeps the
        // dependency timing clean.
        let v = null;
        return () => v || (v = new T.Vector3());
    })();

    // Frustum-fit a plane mesh: scale a unit PlaneGeometry to exactly
    // fill the camera's view at the configured distance, then position
    // it `distance` units in front of the camera and orient it so the
    // texture faces the camera. Called whenever cam.aspect changes
    // (resize) and to position-track the camera each frame.
    function _bgFitBackdropPlane(state) {
        const cam = state.cam;
        const d = state.distance;
        const halfFovRad = cam.fov * Math.PI / 360;
        const visibleHeight = 2 * Math.tan(halfFovRad) * d;
        const visibleWidth = visibleHeight * cam.aspect;
        if (state.lastAspect !== cam.aspect ||
            state.lastVisibleHeight !== visibleHeight) {
            state.mesh.scale.set(visibleWidth, visibleHeight, 1);
            state.lastAspect = cam.aspect;
            state.lastVisibleHeight = visibleHeight;
            // Aspect change shifts the cover-crop ratio; re-apply.
            if (state.applyCoverCrop) state.applyCoverCrop();
        }
        // Track camera each frame: position = cam.position +
        // cam.forward * distance, orient toward camera.
        const fwd = cam.getWorldDirection(_bgBackdropTmp());
        state.mesh.position.copy(cam.position).addScaledVector(fwd, d);
        state.mesh.lookAt(cam.position);
    }

    // Cover-crop a texture to the plane aspect: the larger axis fills
    // the plane (cropped if needed), centered. For wider-than-plane
    // textures the X offset is left at the centered value but the
    // image style's drift loop overwrites it per frame; the video
    // style leaves it centered.
    function _bgCoverCrop(tex, srcW, srcH, planeAspect) {
        if (srcW <= 0 || srcH <= 0) return;
        tex.repeat.set(1, 1);
        tex.offset.set(0, 0);
        const srcAspect = srcW / srcH;
        if (srcAspect > planeAspect) {
            tex.repeat.x = planeAspect / srcAspect;
            tex.offset.x = (1 - tex.repeat.x) * 0.5;
        } else {
            tex.repeat.y = srcAspect / planeAspect;
            tex.offset.y = (1 - tex.repeat.y) * 0.5;
        }
        tex.needsUpdate = true;
    }

    // Background-style registry. Each entry returns a per-panel state
    // object from build() and reads from it in update() / teardown().
    // T (THREE) is set by the time these are invoked (initScene runs
    // inside loadThree().then).
    const BG_STYLES = {
        off: {
            build() { return null; },
            update() {},
            teardown() {},
        },
        particles: {
            build(scene, settings) {
                const N = Math.max(20, Math.floor(80 + 200 * settings.intensity));
                const positions = new Float32Array(N * 3);
                for (let i = 0; i < N; i++) {
                    positions[i * 3] = (Math.random() - 0.5) * 800 * K;
                    positions[i * 3 + 1] = (Math.random() - 0.4) * 80 * K;
                    // Spawn within the visible fog range. Fog reaches
                    // its far limit at FOG_END * 1.2 from the camera,
                    // and cam.position.z is updated each frame in
                    // camUpdate() (`dist * 0.75`, where dist tracks
                    // aspectScale). Anything beyond that camera-relative
                    // distance gets fully fogged out, so the cutoff in
                    // world z is dynamic — the earlier "push past notes"
                    // fix placed particles at -FOG_END * (0.95..1.20)
                    // which sat past fog far at any camera z, making
                    // them invisible. renderOrder = -1 on the bg stage
                    // already keeps particles behind notes regardless
                    // of z, so depth-based separation wasn't needed and
                    // was actively breaking visibility.
                    positions[i * 3 + 2] = -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85;
                }
                const geo = new T.BufferGeometry();
                geo.setAttribute('position', new T.BufferAttribute(positions, 3));
                const mat = new T.PointsMaterial({
                    // size 5*K (bumped from 1.5*K). At distance ~700*K
                    // with sizeAttenuation the prior sprite shrank
                    // below 2 pixels — practically invisible against
                    // dark fog. 5*K reads as a small bright dot.
                    // Build-time opacity is overridden every frame in
                    // update() — the runtime formula is the source of
                    // truth.
                    color: 0xa0c0ff, size: 5 * K, transparent: true,
                    blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
                });
                const points = new T.Points(geo, mat);
                scene.add(points);
                return { points, geo, mat, N };
            },
            update(s, bands, dt) {
                const positions = s.geo.attributes.position.array;
                const dx = dt * (3 + bands.mid * 12) * K;
                for (let i = 0; i < s.N; i++) {
                    positions[i * 3] += dx;
                    if (positions[i * 3] > 400 * K) positions[i * 3] -= 800 * K;
                }
                s.geo.attributes.position.needsUpdate = true;
                // Bumped opacity floor 0.4 → 0.55 + treble headroom
                // 0.4 → 0.45 so particles read as visible specks even
                // when bgReactive is false / treble≈0 (was effectively
                // 0.4 floor, below noise floor against dark fog).
                s.mat.opacity = 0.55 + bands.treble * 0.45;
            },
            teardown(s) {
                if (!s) return;
                s.points.parent?.remove(s.points);
                s.geo.dispose();
                s.mat.dispose();
            },
        },
        silhouettes: {
            build(scene, settings) {
                const canvas = _bgEnsureSilhouetteCanvas();
                // Inside the visible fog range. Fog far = FOG_END * 1.2
                // from the camera, and cam.position.z is dynamic
                // (camUpdate() sets `dist * 0.75`). renderOrder = -1
                // on the bg stage handles "behind notes" regardless
                // of z. Spread the three layers across the back half
                // of the visible fog band for parallax separation.
                const depths = [-FOG_END * 0.55, -FOG_END * 0.70, -FOG_END * 0.85];
                const layers = [];
                const allocated = [];
                try {
                    for (const z of depths) {
                        // Per-layer CanvasTexture wrapping the shared
                        // canvas: lets each layer scroll independently
                        // via texture.offset.x without coupling to its
                        // siblings or to other panels.
                        const tex = new T.CanvasTexture(canvas);
                        tex.wrapS = T.RepeatWrapping;
                        const geo = new T.PlaneGeometry(800 * K, 50 * K);
                        const mat = new T.MeshBasicMaterial({
                            map: tex, transparent: true, opacity: 0.4, depthWrite: false,
                        });
                        const mesh = new T.Mesh(geo, mat);
                        mesh.position.set(0, -10 * K, z);
                        scene.add(mesh);
                        // Parallax: nearer layers move more than farther
                        // ones (perspective). distance = -z; small d ->
                        // large parallax. Scaled so the nearest sits
                        // around 0.32 and farthest around 0.18.
                        const distance = -z;
                        const parallax = Math.max(0.05, 1 - distance / (FOG_END * 1.4));
                        const layer = { mesh, geo, mat, tex, z, drift: 0, parallax };
                        layers.push(layer);
                        allocated.push(layer);
                    }
                    return { layers, intensity: settings.intensity };
                } catch (e) {
                    // Build threw partway — clean up any per-layer
                    // textures we already created. _bgMountStyle's catch
                    // disposes the stage tree's meshes, but a partial-
                    // build's CanvasTextures aren't reachable from any
                    // mesh yet, so this catch owns them.
                    for (const L of allocated) {
                        L.tex?.dispose?.();
                    }
                    throw e;
                }
            },
            update(s, bands, dt) {
                // Intensity multiplier: 0 dims to ~50% of base, 1
                // brightens to ~120%. Below-base values still leave the
                // silhouettes faintly visible so users know the style
                // is on; above-base lets the layers read as a real
                // backdrop on louder passages.
                const intensityMul = 0.5 + s.intensity * 0.7;
                for (const L of s.layers) {
                    // Scroll via texture.offset.x with RepeatWrapping —
                    // unbounded, no modulus snap. The mesh stays put;
                    // the texture wraps continuously across the visible
                    // surface. (offset is in normalized texture space,
                    // so we keep it small and let the wrap do the job.)
                    L.drift += dt * (0.05 + bands.mid * 0.15) * L.parallax;
                    L.mat.map.offset.x = L.drift;
                    L.mesh.position.y = -10 * K + bands.bass * 4 * K;
                    L.mat.opacity = (0.25 + 0.5 * L.parallax) * intensityMul;
                }
            },
            teardown(s) {
                if (!s) return;
                for (const L of s.layers) {
                    L.mesh.parent?.remove(L.mesh);
                    L.geo.dispose();
                    L.mat.dispose();
                    L.tex.dispose();
                }
            },
        },
        lights: {
            build(scene, settings) {
                // Lights count scales 6 → 14 over intensity 0 → 1.
                // _bgCoerce clamps intensity to [0,1] before it reaches
                // here, so no further clamp is needed.
                const N = Math.floor(6 + 8 * settings.intensity);
                const lights = [];
                // Palette comes from the calling panel's settings so
                // each splitscreen panel picks its own (issue #10).
                // Falls back to the default palette if the caller
                // doesn't supply one (e.g. an older code path).
                const palette = settings.palette || PALETTES.default;
                for (let i = 0; i < N; i++) {
                    const color = palette[i % palette.length];
                    // 30*K plane reads as a real stage glow at distance.
                    // Build-time opacity is overridden every frame in
                    // update() — the runtime formula is the source of
                    // truth.
                    const geo = new T.PlaneGeometry(30 * K, 30 * K);
                    const mat = new T.MeshBasicMaterial({
                        color, transparent: true,
                        blending: T.AdditiveBlending, depthWrite: false,
                    });
                    const mesh = new T.Mesh(geo, mat);
                    mesh.position.set(
                        (Math.random() - 0.5) * 600 * K,
                        (Math.random() - 0.3) * 80 * K,
                        // Inside visible fog range; renderOrder = -1
                        // keeps lights behind notes regardless of z.
                        -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85
                    );
                    scene.add(mesh);
                    lights.push({ mesh, geo, mat, baseScale: 1 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
                }
                return { lights };
            },
            update(s, bands, dt, t) {
                // Bumped opacity floor 0.35 → 0.55 + treble headroom
                // 0.3 → 0.4 so lights read as visible stage glows at
                // distance instead of faint specks (was effectively
                // 0.35 floor since the build-time bump was overridden
                // by this formula).
                for (const L of s.lights) {
                    const pulse = 1 + bands.bass * 1.5 + Math.sin(t * 1.5 + L.phase) * 0.2;
                    L.mesh.scale.set(L.baseScale * pulse, L.baseScale * pulse, 1);
                    L.mat.opacity = 0.55 + bands.treble * 0.4;
                }
            },
            teardown(s) {
                if (!s) return;
                for (const L of s.lights) {
                    L.mesh.parent?.remove(L.mesh);
                    L.geo.dispose();
                    L.mat.dispose();
                }
            },
        },
        geometric: {
            build(scene, settings) {
                const meshes = [];
                // Bumped opacity floor (0.25 → 0.45) + ceiling so the
                // wireframes read as real shapes instead of barely-
                // there ghosts at low intensity.
                const op = 0.45 + 0.25 * settings.intensity;
                const ico = new T.Mesh(
                    new T.IcosahedronGeometry(30 * K, 1),
                    new T.MeshBasicMaterial({ color: 0x6080c0, wireframe: true, transparent: true, opacity: op, depthWrite: false }),
                );
                // Inside visible fog range; renderOrder = -1 keeps
                // wireframes behind notes regardless of z.
                ico.position.set(-100 * K, 30 * K, -FOG_END * 0.65);
                scene.add(ico);
                meshes.push(ico);
                const torus = new T.Mesh(
                    new T.TorusGeometry(22 * K, 4 * K, 6, 12),
                    new T.MeshBasicMaterial({ color: 0xc06080, wireframe: true, transparent: true, opacity: op * 0.9, depthWrite: false }),
                );
                torus.position.set(120 * K, 20 * K, -FOG_END * 0.75);
                scene.add(torus);
                meshes.push(torus);
                return { meshes };
            },
            update(s, bands, dt) {
                const speed = 0.2 + bands.mid * 0.4;
                const pulse = 1 + bands.bass * 0.25;
                for (const m of s.meshes) {
                    m.rotation.x += dt * speed * 0.3;
                    m.rotation.y += dt * speed * 0.4;
                    m.scale.setScalar(pulse);
                }
            },
            teardown(s) {
                if (!s) return;
                for (const m of s.meshes) {
                    m.parent?.remove(m);
                    m.geometry.dispose();
                    m.material.dispose();
                }
            },
        },
        // Custom image backdrop (#19). User uploads a JPG/PNG/WebP
        // through settings.html; the bytes are persisted as a base64
        // data URL in localStorage under h3d_bg_customImageDataUrl and
        // passed in via settings.customImageDataUrl. Renders as a
        // PlaneGeometry in the silhouette parallax band, "cover" cropped
        // (via texture.repeat / offset) so non-matching aspects fill
        // the plane without distortion. Slow horizontal drift on
        // texture.offset.x for life. When no asset is uploaded, build
        // returns null and the style is inert (settings.html disables
        // the picker option in that case).
        image: {
            build(scene, settings) {
                // Upfront validation: only accept the same raster image
                // formats settings.html lets the user upload (jpeg /
                // png / webp). Without this, a corrupt localStorage
                // value (truncated base64, wrong scheme, plain string)
                // OR an unsupported type (e.g. data:image/svg+xml)
                // reaches TextureLoader and can fail asynchronously
                // after the plane has been mounted — a silent black
                // backdrop with no clear cause. Returning null here
                // treats invalid bytes the same as "no asset uploaded":
                // style is inert, the user can clear and re-upload
                // from settings.html.
                const dataUrl = (typeof settings.customImageDataUrl === 'string')
                    ? settings.customImageDataUrl.trim() : '';
                if (!/^data:image\/(jpeg|png|webp);/i.test(dataUrl)) return null;
                // Renderer-side encoded-length cap. settings.html
                // enforces the same limit on upload, but a manually
                // edited localStorage value (or legacy data from
                // before the upload guard existed) could still feed
                // an arbitrarily large data URL into TextureLoader
                // and burn memory / CPU during decode. Treat overlong
                // values as "no asset" — style is inert, user can
                // clear and re-upload from settings.
                if (dataUrl.length > 2.5 * 1024 * 1024) return null;
                // Renderer-side decompression-bomb caps. Mirror
                // settings.html's upload-time guard so a manual
                // localStorage edit (or legacy data from before that
                // guard existed) can't sneak a 50000×50000 PNG past
                // and OOM the GPU on texture upload.
                const MAX_IMAGE_DIM = 4096;
                const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
                // Full-bleed backdrop: unit plane, scaled per frame in
                // _bgFitBackdropPlane to fill the camera's view at
                // BG_BACKDROP_DISTANCE. fog: false so the backdrop
                // shows in full color; notes drawn on top still pick
                // up atmospheric fog as before.
                const state = {
                    mesh: null, geo: null, mat: null, tex: null,
                    drift: 0.5, intensity: settings.intensity, loaded: false,
                    cam: settings.cam, distance: BG_BACKDROP_DISTANCE,
                    lastAspect: 0, lastVisibleHeight: 0,
                };
                // Helper closure for cover-crop refresh — called both
                // on async decode (initial) and from _bgFitBackdropPlane
                // when the camera aspect changes (resize).
                state.applyCoverCrop = function () {
                    if (!state.tex || !state.tex.image) return;
                    _bgCoverCrop(
                        state.tex,
                        state.tex.image.width  || 0,
                        state.tex.image.height || 0,
                        state.cam.aspect,
                    );
                };
                const tex = new T.TextureLoader().load(
                    dataUrl,
                    (loaded) => {
                        // Image dimensions are only known after async decode.
                        const imgW = loaded.image?.width  || 0;
                        const imgH = loaded.image?.height || 0;
                        if (imgW > MAX_IMAGE_DIM || imgH > MAX_IMAGE_DIM || (imgW * imgH) > MAX_IMAGE_PIXELS) {
                            // Bail before the texture gets uploaded to
                            // the GPU (Three.js uploads on first render
                            // of a visible mesh — hiding the mesh here
                            // skips that). Disposing the texture too,
                            // belt-and-suspenders, in case anything
                            // else holds a reference.
                            console.warn('[3D-Hwy] custom image dimensions too large to render', imgW + 'x' + imgH);
                            if (state.mesh) state.mesh.visible = false;
                            loaded.dispose();
                            return;
                        }
                        state.applyCoverCrop();
                        // Reset drift to the centered triangle-wave
                        // phase now that repeat.x is final. Without
                        // this reset, drift accumulated during the
                        // async decode would phase-shift the initial
                        // offset by a non-deterministic amount —
                        // wider images would open at whatever crop
                        // the elapsed-decode-time happened to land on.
                        state.drift = 0.5;
                        state.loaded = true;
                    },
                    undefined,
                    // Async-failure path: the upfront regex catches the
                    // common "corrupted/truncated bytes" case, but a
                    // valid-looking data URL can still fail to decode
                    // (e.g. wrong MIME / unsupported codec). Hide the
                    // mesh so we don't paint a frozen blank plane on
                    // top of fog, and log so the failure isn't silent.
                    (err) => {
                        console.error('[3D-Hwy] custom image decode failed', err);
                        if (state.mesh) state.mesh.visible = false;
                    },
                );
                tex.colorSpace = T.SRGBColorSpace;
                // ClampToEdge on both axes — user uploads are non-
                // power-of-two in general, and WebGL1 rejects RepeatWrapping
                // on NPOT textures (renders black or emits GL errors). The
                // drift logic below uses a triangle-wave so the offset
                // stays inside [0, 1-repeat] and never needs wrap.
                tex.wrapS = T.ClampToEdgeWrapping;
                tex.wrapT = T.ClampToEdgeWrapping;
                // User uploads aren't power-of-two in general; mipmaps
                // are noisy for a single static backdrop and burn memory.
                tex.generateMipmaps = false;
                tex.minFilter = T.LinearFilter;
                tex.magFilter = T.LinearFilter;
                const geo = new T.PlaneGeometry(1, 1);
                const mat = new T.MeshBasicMaterial({
                    map: tex, transparent: false, depthWrite: false, fog: false,
                });
                const mesh = new T.Mesh(geo, mat);
                scene.add(mesh);
                state.mesh = mesh;
                state.geo  = geo;
                state.mat  = mat;
                state.tex  = tex;
                // Initial fit so the first frame is correctly sized
                // and positioned, even if update() hasn't run yet.
                _bgFitBackdropPlane(state);
                return state;
            },
            update(s, bands, dt) {
                if (!s) return;
                // Track camera position / aspect every frame. The
                // helper resizes the plane and refreshes cover-crop
                // when aspect changes, and re-positions the plane to
                // stay BG_BACKDROP_DISTANCE in front of the camera.
                _bgFitBackdropPlane(s);
                // Skip drift advance until the texture has finished
                // decoding. Without this guard, drift accumulates
                // during the async load while repeat.x is still 1
                // (its default), and once the cover-crop applies the
                // image opens at a phase-shifted offset whose value
                // depends on how long the decode took — the
                // "centered start" intent becomes non-deterministic.
                if (!s.loaded) return;
                // Triangle-wave ping-pong drift inside the cropped slack.
                // ClampToEdge on wrapS means we cannot wrap across the
                // texture boundary (would render edge pixels stretched);
                // ping-pong oscillates the visible window between the
                // image's left and right edges, which gives the same
                // "alive" feel without the WebGL1 NPOT-Repeat hazard.
                // Slack is the horizontal margin between the cropped
                // window and the texture edges; for taller-than-plane
                // images repeat.x stays 1, slack collapses to 0, and
                // the offset stays at 0 — the image sits still, which
                // is correct (it's already filling horizontally).
                s.drift += dt * 0.02 * s.intensity;
                const slack = Math.max(0, 1 - s.tex.repeat.x);
                // Period of 2 drift units ≈ 100 s at intensity = 0.5;
                // gentle, cinematic. cyc ∈ [0, 2), tri ∈ [0, 1] then back.
                const cyc = ((s.drift % 2) + 2) % 2;
                const tri = cyc < 1 ? cyc : 2 - cyc;
                s.tex.offset.x = tri * slack;
            },
            teardown(s) {
                if (!s) return;
                s.mesh.parent && s.mesh.parent.remove(s.mesh);
                s.geo.dispose();
                s.mat.dispose();
                // This style owns the texture lifecycle (per the comment
                // at _bgDisposeGroupTree: tree dispose does NOT touch
                // material.map textures).
                s.tex.dispose();
            },
        },
        // Custom video backdrop (#19 follow-up). User uploads a
        // .mp4/.webm via settings.html; routes.py stores it on disk and
        // serves a same-origin URL (avoids CORS taint on VideoTexture).
        // localStorage holds only the filename — bytes live in
        // {config_dir}/plugin_uploads/highway_3d/. Per-panel video
        // element so each panel can mount/teardown independently;
        // browsers cache the video bytes after first fetch so multi-
        // panel splitscreen pays only the decoder cost, not the
        // network or disk-read cost.
        video: {
            build(scene, settings) {
                // Lowercase before validation so a manual localStorage
                // edit like `current.MP4` doesn't pass a case-insensitive
                // regex check and then 404 against the server, which
                // only ever produces and serves lowercase
                // current.<ext> (the upload route lowercases the
                // extension; routes.py's GET pattern is case-sensitive).
                const filename = (typeof settings.customVideoName === 'string')
                    ? settings.customVideoName.trim().toLowerCase() : '';
                // Strict pattern matches routes.py's deterministic
                // single-slot naming. Any other shape (corrupt
                // localStorage, future schema change) → style is
                // inert, no <video> created, no orphan request to a
                // 404 endpoint.
                if (!/^current\.(mp4|webm)$/.test(filename)) return null;
                const url = '/api/plugins/highway_3d/files/' + filename;

                // Track partial allocations so a throw between any of
                // them can clean up. _bgMountStyle's failure path
                // disposes the stage tree but explicitly does NOT
                // dispose textures (per the comment at
                // _bgDisposeGroupTree), and the <video> element is
                // parented to document.body — not the stage — so
                // neither would be reached without an explicit catch.
                let videoEl = null, tex = null, geo = null, mat = null, mesh = null;
                try {
                    // muted + playsInline + autoplay is the cross-
                    // browser recipe that bypasses gesture requirements
                    // (Chrome, Firefox, Safari desktop + mobile).
                    // preload='auto' lets the first frame land before
                    // play() is called. src is deliberately NOT set
                    // yet — we want every piece of state (mesh, tex)
                    // to exist before the browser can fire
                    // loadedmetadata or error events on a cached
                    // resource. The handlers close over state.tex /
                    // state.mesh; setting src first would create a
                    // window where a fast cache hit could fire an
                    // event into half-initialized state.
                    videoEl = document.createElement('video');
                    // No crossOrigin attribute: the URL is same-origin
                    // (/api/plugins/highway_3d/files/…), so VideoTexture
                    // never sees a tainted canvas. Setting
                    // `crossOrigin = "anonymous"` would also strip
                    // cookies from the fetch, which would 401 against
                    // any cookie-protected slopsmith deployment. If
                    // this ever needs to fetch cross-origin, switch
                    // to `use-credentials` AND have the server send
                    // the matching CORS headers.
                    videoEl.muted = true;
                    videoEl.playsInline = true;
                    videoEl.loop = true;
                    videoEl.autoplay = true;
                    videoEl.preload = 'auto';
                    videoEl.style.display = 'none';
                    document.body.appendChild(videoEl);

                    // Build mesh + texture before registering listeners
                    // and before setting src. By the time loadedmetadata
                    // or error can fire, state.tex and state.mesh are
                    // both populated.
                    tex = new T.VideoTexture(videoEl);
                    tex.colorSpace = T.SRGBColorSpace;
                    tex.wrapS = T.ClampToEdgeWrapping;
                    tex.wrapT = T.ClampToEdgeWrapping;
                    tex.minFilter = T.LinearFilter;
                    tex.magFilter = T.LinearFilter;
                    tex.generateMipmaps = false;
                    geo = new T.PlaneGeometry(1, 1);
                    mat = new T.MeshBasicMaterial({
                        map: tex, transparent: false, depthWrite: false, fog: false,
                    });
                    mesh = new T.Mesh(geo, mat);
                    scene.add(mesh);

                    // Full-bleed backdrop: scaled and positioned each
                    // frame in update() via _bgFitBackdropPlane.
                    // cam + distance + lastAspect / lastVisibleHeight
                    // power that helper.
                    const state = {
                        videoEl, mesh, geo, mat, tex,
                        cam: settings.cam, distance: BG_BACKDROP_DISTANCE,
                        lastAspect: 0, lastVisibleHeight: 0,
                    };
                    state.applyCoverCrop = function () {
                        if (!state.videoEl) return;
                        _bgCoverCrop(
                            state.tex,
                            state.videoEl.videoWidth  || 0,
                            state.videoEl.videoHeight || 0,
                            state.cam.aspect,
                        );
                    };

                    // Cover-crop math runs on loadedmetadata since
                    // video dimensions aren't known until then.
                    // _bgFitBackdropPlane will also re-apply when the
                    // camera aspect changes.
                    videoEl.addEventListener('loadedmetadata', () => {
                        state.applyCoverCrop();
                    });
                    videoEl.addEventListener('error', () => {
                        // Fired for: codec unsupported, 404 from
                        // server, truncated file, etc. Hide the mesh
                        // so we don't paint a frozen blank plane on
                        // top of fog.
                        console.error('[3D-Hwy] custom video load failed', videoEl.error);
                        state.mesh.visible = false;
                    });

                    // Set src last — this is what triggers the async
                    // load. With handlers and state in place, any
                    // synchronous-feeling event from a cached resource
                    // is still safely received and handled.
                    videoEl.src = url;

                    // play() can reject for transient reasons (tab
                    // backgrounded at mount time, low-power mode,
                    // brief autoplay-policy timing window) even with
                    // muted + autoplay set — but the browser retries
                    // on its own once conditions improve (visibility
                    // change, foregrounding, gesture). Real load /
                    // codec failures come through the `error` event
                    // we registered above and DO hide the mesh. So
                    // just log here and leave the mesh visible; the
                    // next ready frame will paint.
                    videoEl.play().catch((err) => {
                        console.warn('[3D-Hwy] custom video play() rejected (will retry on visibility/gesture)', err);
                    });
                    // Initial fit so the first frame is correctly
                    // sized and positioned even before update() runs.
                    _bgFitBackdropPlane(state);
                    return state;
                } catch (err) {
                    // Best-effort cleanup of whatever was allocated
                    // before the throw. Each step is independently
                    // guarded so a secondary failure (e.g. dispose
                    // throwing on an already-disposed object) can't
                    // mask the original error.
                    try {
                        if (videoEl) {
                            videoEl.pause();
                            videoEl.removeAttribute('src');
                            videoEl.load();
                            if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
                        }
                    } catch (_) { /* ignore */ }
                    try { if (mesh && mesh.parent) mesh.parent.remove(mesh); } catch (_) { /* ignore */ }
                    try { if (geo) geo.dispose(); } catch (_) { /* ignore */ }
                    try { if (mat) mat.dispose(); } catch (_) { /* ignore */ }
                    try { if (tex) tex.dispose(); } catch (_) { /* ignore */ }
                    throw err;
                }
            },
            update(s) {
                if (!s) return;
                // VideoTexture auto-updates from the playing element —
                // Three.js samples the current frame each render. No
                // per-frame texture mutation here. Drift on offset.x
                // is intentionally omitted: the video's own motion is
                // the "life", drifting the crop on top would feel
                // busy and compete with playback. The only per-frame
                // work is keeping the plane camera-locked and resized
                // when aspect changes (handled inside the helper).
                _bgFitBackdropPlane(s);
            },
            teardown(s) {
                if (!s) return;
                if (s.videoEl) {
                    try { s.videoEl.pause(); } catch (_) {}
                    s.videoEl.removeAttribute('src');
                    // load() with no src tells the browser to release
                    // any decoder/buffer state for this element.
                    try { s.videoEl.load(); } catch (_) {}
                    if (s.videoEl.parentNode) s.videoEl.parentNode.removeChild(s.videoEl);
                }
                if (s.mesh) s.mesh.parent && s.mesh.parent.remove(s.mesh);
                if (s.geo) s.geo.dispose();
                if (s.mat) s.mat.dispose();
                if (s.tex) s.tex.dispose();
            },
        },
    };

    /* ======================================================================
     *  Per-instance counter
     * ====================================================================== */

    let _nextInstanceId = 0;

    /* ======================================================================
     *  Factory — slopsmith#36 setRenderer contract
     * ====================================================================== */

    function createFactory() {
        const _instanceId = ++_nextInstanceId;

        // ── Per-instance Three.js state ───────────────────────────────────
        let scene = null, cam = null, ren = null;
        let wrap = null;
        // highway:visibility listener (slopsmith#246). Hides the .h3d-wrap
        // overlay when slopsmith's canvas is display:none'd (splitscreen
        // case). Without this, the wrap is a *sibling* of #highway so
        // hiding #highway leaves the WebGL scene painting full-screen.
        // Bound in initScene after wrap creation, unbound in destroy().
        let _visibilityHandler = null;
        // highway:canvas-replaced listener — keeps highwayCanvas up to
        // date across context-type swaps (e.g. swapping back to a 2D
        // viz). The visibility handler's identity gate (event.detail.
        // canvas === highwayCanvas) would otherwise stop matching
        // after the swap; this listener follows the documented plugin
        // contract from CLAUDE.md.
        let _canvasReplacedHandler = null;
        let ambLight = null, dirLight = null;
        let fretG = null, tuningLblG = null, noteG = null, beatG = null, lblG = null;
        let gNote = null, gSus = null, gBeat = null, gTapChevron = null;
        let mStr = [], mGlow = [], mSus = [], mStrHitOutline = [], mAccentOutline = [], mAccentCore = [], mAccentHaloNear = [], mAccentHaloMid = [], mAccentHaloFar = [];
        let mWhiteOutline = null, mSusOutline = null;
        // Shared materials for the legato technique meshes — one per geometry
        // type, reused across every pooled mesh instance to avoid per-mesh
        // material allocation in dense HO/PO/tap passages. Allocated in
        // initScene() alongside the other scene materials and disposed in
        // teardown.
        let mTapChevron = null;
        // Barre indicator material (white vertical line at the barre fret
        // during chord linger). Promoted from inline pool-factory authoring
        // to a named module-scope reference so _applyGlow() can mutate
        // emissiveIntensity in place when the user drags the glow slider.
        let mBarre = null;
        // Notedetect feedback outlines (issue #9). Created in initScene
        // alongside mWhiteOutline; swapped onto the note's outline mesh
        // when a recent notedetect:hit / :miss event matches the note's
        // (s, f, t).
        let mHitOutline = null, mMissOutline = null, mMissCore = null;
        let pSusOutline = null;
        let projMeshArr = null;
        let _probe = null;
        let _ghostLblBox = null;
        let _ghostLblMid = null;
        let _ghostLblTowardCam = null;
        /** Snapshotted in update() for drawNote() ghost / glow (single source vs per-caller isNext). */
        let _drawNextByString = null;
        /** Snapshotted in update() — drawNote() is a sibling of update(), not nested in its closure. */
        let _drawChordTemplates = null;
        let _laneTargetColor = null;
        let _renderScale = 1;
        let lyricsCanvas = null, lyricsCtx = null;
        let _diagChord            = null;
        let pSusRail = null, gSusRail = null, mSusRailBase = null;
        let pSusRailBloom = null, gSusRailBloom = null, mSusRailBloomBase = null, _bloomGaussTex = null;
        let pTechPlane = null, gTechPlane = null;
        let _diagPrev             = null;
        let _diagPrevOpacity      = 0;
        let _diagPrevStartOpacity = 0;
        let _diagPrevStartT       = null;  // bundle.currentTime when crossfade began (drives rewindable fade)
        let _diagEntranceT        = 1.0;
        let _diagLastKey          = null;  // chord identity: name + '|' + frets.join(',')
        // Per-wave cache for fret-column reference markers. Keyed by the
        // wave's beat timestamp. We snapshot { hasLow, hasHigh, fretList,
        // anchorKeyed } at first sight of a wave so its render gate stays consistent through the
        // wave's flight even as activeFrets shifts mid-song. Entries are
        // pruned each frame once their wave has passed `now`.
        let _fretMarkerWaveCache = new Map();
        // Per-frame booleans: handShapes[i] passes inferArpeggioFromNotePattern
        // once (see fillArpeggioGhostInferFlags) so the note loop skips O(hs×notes)
        // rescans — ref fillArpeggioGhostInferFlags in update().
        let _arpGhostHsInferScratch = [];
        /** Per-frame: ``handShapeIsArpeggioForLaneRail`` baked once — lane slices were O(96 × hs × infer). */
        let _arpLaneRailHsScratch = [];
        let _arpRailBoundLoScratch = [];
        let _arpRailBoundHiScratch = [];

        // ── Cross-frame caches for chart-static derivations ──────────────
        // The merge + arp-flag fills below depend only on chart-static
        // input arrays (handShapes / chords / chordTemplates / notes),
        // not on `now`. The bundle hands us the same array refs every
        // frame within an arrangement, so we can skip the recompute when
        // the inputs are identity-equal to the previous frame's. On dense
        // arrangements this avoids per-frame Set construction, nested
        // O(hs × notes) scans, and a sort — significant FPS recovery.
        let _mergeCacheResult = null;
        let _mergeCacheChordsRef = null;
        let _mergeCacheHsRef = null;
        let _mergeCacheTplRef = null;

        let _arpGhostInferRefHs = null;
        let _arpGhostInferRefNotes = null;
        let _arpGhostInferRefTpl = null;

        // Slide-target gem suppression. A Set of "t_s" keys for notes in
        // bundle.notes that are the linkNext destination of a preceding note
        // (single or chord). The gem is suppressed (skipBody=true) but the
        // sustain/slide trail still renders so the slide motion stays visible.
        let _slideTargetSet = null;
        let _slideTargetNotesRef = null;
        let _slideTargetChordsRef = null;

        let _laneRailFlagsRefHs = null;
        let _laneRailFlagsRefTpl = null;

        let _laneRailBoundsRefHs = null;
        let _laneRailBoundsRefChords = null;
        let _laneRailBoundsRefTpl = null;
        let _laneRailBoundsRefNotes = null;
        let _lastHwW = 0, _lastHwH = 0;
        let mBeatM = null, mBeatQ = null;
        let txtCache = {};
        // Cloned sprite materials cached on individual sprite instances
        // (e.g. pmMark._pmMat). pLbl pool reuses sprites across labels,
        // so when a sprite is later assigned a different material the
        // _pmMat stays referenced on the sprite itself but isn't reached
        // by the scene.traverse-based dispose. Track them here so
        // teardown can dispose them explicitly.
        const _ownedClonedMats = [];
        // Per-mesh technique-marker clones — keyed by mesh, disposed when
        // the source sprite's map changes or on teardown. Replaces the old
        // unbounded push-per-frame approach in _spriteMat2MeshMat.
        const _techMeshMatClones = new Set();
        // Shared (non-clone) materials and geometries that pool factories
        // reference but that aren't guaranteed to be reachable via
        // scene.traverse() — e.g. mLaneEven is only reached if at least one
        // even-numbered fret stripe ever spawns. Track them here so teardown
        // disposes the GPU resource regardless.
        const _ownedSharedMats = [];
        const _ownedSharedGeos = [];

        // Background animation state (issue #13). bgGroup is the parent
        // container for all bg meshes so teardown is one remove + dispose
        // pass. bgState is the active style's per-panel state object.
        let bgGroup = null, bgStage = null, bgState = null;
        let bgStyleId = 'particles', bgIntensity = 0.5, bgReactive = true;
        // Active palette for this panel (issue #10). Materials and per-
        // frame color reads inside createFactory all consult this rather
        // than the module-level S_COL, so a palette swap re-tints the
        // panel live without touching module-level state.
        let activePalette = PALETTES.default;
        // Fret digits on the board ghost (hollow preview at Z=0), not on
        // flying note bodies — see fretNumberGhostScope for Rocksmith vs all.
        let showFretOnNote = false;
        let fretNumberGhostScope = 'rocksmith';
        // Camera-X smoothing dial (issue #34). 0 = twitchy (track every
        // upcoming fret), 1 = calm (ignore small intra-cluster shifts).
        // Cached here and refreshed via the bg listener to avoid a
        // per-frame localStorage hit inside update().
        let cameraSmoothing = 0.5;
        // Per-axis follow-ups: zoom (tgtDist hysteresis) and vertical-tilt
        // (tgtLookY NDC self-correction) each get their own dial. Same
        // 0..1 shape; same caching pattern. Both mirror cameraSmoothing's
        // value when not explicitly stored, so existing users who only
        // ever moved the camera-smoothing slider get the same calmness on
        // the new axes by default.
        let zoomSmoothing = 0.5;
        let tiltSmoothing = 0.5;
        // Camera lock: when true, pin the camera to a fixed wide view of
        // frets 1-12 unless an upcoming note would otherwise be off-screen.
        // The lock disengages while any note above fret 12 is in the
        // lookahead window so the camera can briefly widen to include it,
        // then re-engages once the high note ages out.
        let cameraLockLow = false;
        // Zoom-level for the locked view. Slider 0..1 maps to a multiplier
        // on the locked tgtDist: 0 → CAM_LOCK_ZOOM_MIN (closest, biggest
        // fretboard), 0.5 → 1.0× (the default locked view), 1 → CAM_LOCK_ZOOM_MAX
        // (furthest). Inactive when the lock isn't engaged.
        let cameraLockZoom = 0.5;
        /** 'steady' = recency-weighted centroid + hysteresis (#34); 'lookahead' = wide preview window + smooth focal. */
        let cameraMode = BG_DEFAULTS.cameraMode;
        // Global text-size multiplier for in-scene text sprites (chord
        // names, fret labels, section banners, technique markers, etc.).
        // Slider is 0..1; mapped to a 0.5..1.5× multiplier with 0.5 = 1.0×
        // (current default behaviour). _textSizeMul is the materialized
        // multiplier — refreshed once per frame at the top of update()
        // and consumed by every text-sprite scale.set call inside update
        // and drawNote.
        let textSize = 0.5;
        let _textSizeMul = 1.0;
        // Visual look dials (issue: pastel/washed-out feel + too-much-glow
        // complaint). vibrancy raises idle string/note opacity and de-whites
        // the hit-note body; glow scales every emissive contribution +
        // projection glow layer opacity. Sliders are 0..1; defaults lean
        // vivid + minimal-glow to match the requested out-of-box look.
        // _vibrancyIdleOp / _vibrancyProjOp are cached so
        // updateStringHighlights() and drawNote() don't recompute the
        // linear blend every frame.
        let vibrancy            = BG_DEFAULTS.vibrancy;
        let glowMul             = BG_DEFAULTS.glow;
        let chordDiagramSize     = BG_DEFAULTS.chordDiagramSize;
        let chordDiagramPosition = BG_DEFAULTS.chordDiagramPosition;
        let fretColumnMarkerCadence = BG_DEFAULTS.fretColumnMarkerCadence;
        let inlayLabelsVisible = BG_DEFAULTS.inlayLabelsVisible;
        let sectionLabelsOnHighway = BG_DEFAULTS.sectionLabelsOnHighway;
        let sectionHudVisible      = BG_DEFAULTS.sectionHudVisible;
        let sectionHudPosition     = BG_DEFAULTS.sectionHudPosition;
        let sectionHudSize         = BG_DEFAULTS.sectionHudSize;
        let nutHeadstockVisible    = BG_DEFAULTS.nutHeadstockVisible;
        let tuningLabelsVisible    = BG_DEFAULTS.tuningLabelsVisible;
        let nutColor               = BG_DEFAULTS.nutColor;
        let headstockColor         = BG_DEFAULTS.headstockColor;
        let projectionVisible      = BG_DEFAULTS.projectionVisible;   // board "note preview" ghost on the fretboard
        let _vibrancyIdleOp = 0.4  + 0.6  * BG_DEFAULTS.vibrancy;
        let _vibrancyProjOp = 0.15 + 0.35 * BG_DEFAULTS.vibrancy;
        // Custom image asset (issue #19). Data URL is the bytes that
        // drive the 'image' bg style's texture; name is display-only
        // metadata that settings.html shows next to the file picker.
        let bgCustomImageDataUrl = '';
        let bgCustomImageName = '';
        // Custom video asset (issue #19 follow-up). Stores the
        // server-side filename only; bytes live on disk via routes.py.
        // The renderer composes the served URL from this filename in
        // BG_STYLES.video.build.
        let bgCustomVideoName = '';
        let _bgListener = null;
        let _bgLastT = 0;  // ms timestamp for dt

        // Notedetect feedback (issue #9). Per-panel mark queues populated
        // by two event sources: (a) legacy `notedetect:hit` /
        // `notedetect:miss` window CustomEvents, and (b) Slopsmith
        // event-bus `note:hit` / `note:miss` events (subscribed in
        // initScene() when window.slopsmith exposes both `on` and `off`).
        // Both sources feed the same _ndPushMark() helper which dedupes
        // dual emissions. drawNote looks up its (s, f, t) against these
        // arrays each frame and swaps the outline material when a match
        // is current. Marks expire after _ND_TTL_MS so the visual flash
        // is brief. Marks self-prune unconditionally in the listener and
        // once per frame in update() to keep the arrays small.
        const _ND_TTL_MS = 500;
        const _ND_TIME_EPS = 0.01;
        let _ndHitMarks = [];
        let _ndMissMarks = [];
        let _ndOnHit = null, _ndOnMiss = null;
        let _ndOnBusHit = null, _ndOnBusMiss = null;
        let _ndLabels = [];
        // slopsmith#254 — per-frame queue of confirmed-hit/active notes
        // ({x, y, z, s, alpha, color} in world space; alpha is the
        // provider's clamped 0..1 fade — drawNotedetectSizzle scales
        // opacity/density by it; color is an optional override for the
        // string-tinted half of the dot/arc colour mix). drawNote() fills
        // it; after ren.render(), drawNotedetectSizzle() projects each
        // through the camera and twinkles a few tiny dots on the note.
        // Rebuilt every frame, so the sparkle follows the note and
        // persists exactly as long as the provider keeps reporting
        // hit/active for it.
        let _ndSizzle = [];
        // Per-chord-occurrence verdict latch for the chord-frame rim
        // tint. Once a chord is observed all-hit/active during its linger
        // fade we latch 'green' here so subsequent frames can't undo it
        // as individual constituent glows decay and getNoteState starts
        // returning null again (which would otherwise flicker the rim
        // back to red mid-linger). Keyed by `${ch.id}|${ch.t}` — ch.id
        // alone is the chord *template* id and is reused across every
        // occurrence of the same shape, so id-only latching would bleed
        // a single clean grab onto every later occurrence of that chord.
        // Pre-hit-line invalidation (chDt > 0 path in the rim selection)
        // evicts a chord's latch the next time it's seen approaching, so
        // loops/rewinds re-judge from scratch and the Map can't grow
        // beyond the current pre-hit-line frontier. Also cleared in
        // destroy().
        let _chordVerdicts = new Map();
        // Previous-frame `now` for the chord-verdicts pruner — on a
        // backward seek the latches behind that time become "future"
        // entries the forward-only prune can't reach, so we wipe the
        // map instead of paying an O(n) scan per frame to find them.
        let _chordVerdictsLastNow = null;
        // Per-frame timestamp captured by update() and used by its
        // prune pass for the notedetect mark arrays. drawNote itself
        // no longer reads it — pruning lives once per frame so
        // drawNote's hot path is just the bounded (s, f, t) match.
        let _ndFrameNowMs = 0;
        // slopsmith#254 — core's per-note judgment provider, captured
        // from `bundle.getNoteState` at the top of each update(). When
        // present it's authoritative over the event-driven marks above:
        // 'hit'/'active' → bright string-tinted outline (mGlow[s]) +
        // bright body + glowing sustain trail + a contained sparkle on
        // the overlay (a held sustain keeps glowing/sparkling for as
        // long as it stays 'active'); 'miss' → red outline (mMissOutline)
        // + suppressed body. null on cores without the API or songs
        // with no scorer registered. Older note_detect builds that only
        // emit notedetect:hit/miss events still work via _ndHitMarks.
        let _ndGetNoteState = null;
        let _ndHasProvider = false;  // true iff a note-state provider is registered (slopsmith#254)

        // Object pools
        let pNote, pSus, pLbl, pBeat, pSec;
        let pFretLbl, pLane, pLaneDivider;
        // Shared materials/geometry for the lane stripes — see initScene().
        // Hoisted so draw() can reference them when assigning per-stripe.
        let mLaneOdd = null, mLaneEven = null, gLanePlane = null;
        /** Lane fret dividers: default white vs arpeggio frame tint on outer wires only. */
        let mLaneDivider = null, mLaneDividerArp = null;
        /** Shared XY plane for ghost fret digits (lies on board like proj, not billboarding). */
        let gGhostFretPlane = null, pGhostFretLbl = null;
        // Anchor-driven lane scratch buffers. Per-frame the loop builds up
        // to HWY_LANE_TIME_SLICES segments, but consecutive slices that share
        // an anchor (the common case) collapse into the same entry. Held as
        // four parallel arrays so the per-frame work allocates nothing once
        // the buffers reach their steady-state size.
        const _laneSegDMin = [];
        const _laneSegDMax = [];
        const _laneSegZ0 = [];
        const _laneSegZ1 = [];
        /** Chart-time span per merged lane segment (for per-slice arpeggio rail tint). */
        const _laneSegTLo = [];
        const _laneSegTHi = [];
        const _laneSegArp = [];
        let _laneSegLen = 0;
        let pChordBox, pChordFrameFill, pChordLbl, pBarreLine, pPMXFill, pFHXFill;
        let gPMXFill = null; // shared geometry for PM X fill — disposed in teardown
        let gFHXFill = null; // shared geometry for FH X fill — disposed in teardown
        let pNoteFretLabel, pConnectorLine, pDropLine, pTapChevron, pAccentHalo;
        let pChordAccentHalo = null, gChordAccentHalo = null; // per-instance cloned mats so opacity differs per shell
        let pSusRibbon = null, pSusRibbonOl = null;
        let pFretColMarker;
        /** Horizontal gradient for chord box interior fill. */
        let chordFrameGradTex = null;
        /** Lavender gradient for arpeggio box interior (normal map is ciano × lavanda → segue ciano). */
        let chordFrameGradTexArp = null;

        // Dynamic glowing string meshes (BoxGeometry, one per string)
        let stringLines = [];
        // Static thin-line glow layer behind each string (one Line per
        // string). Retained so _applyVibrancy() can mutate opacity in
        // place — without this the layer stays at its built-in opacity
        // until the next palette change rebuilds buildBoard().
        let stringLineGlows = [];
        /** Nut + headstock 3D subtree; visibility toggled from settings without rebuild. */
        let nutHeadstockGroup = null;
        /** Left edge X of drawable string meshes; updated in buildBoard() at nut / fret junction. */
        let boardStringStartX = fretX(0);
        /** Open-string label column X — over headstock, left of nut (set in buildBoard()). */
        let boardTuningLabelX = -4.2 * K;
        // Fret inlay number label sprites (one per INLAY_LABEL_FRETS entry).
        // Retained so update() can rescale them live when _textSizeMul changes.
        let _inlayLabels = [];
        // Cloned SpriteMaterials for the inlay labels — disposed on rebuild and
        // destroy() to prevent GPU leaks across palette changes or panel reuse.
        let _inlayMats = [];
        // Open-string tuning labels beside the headstock (issue: per-song tuning).
        let _tuningLabelSprites = [], _tuningLabelMats = [];
        let _lastOpenStringLblSig = '';
        // Cheap-key cache for _syncOpenStringPitchLabels: skip the expensive
        // labels-array + signature-string build when the inputs that actually
        // change the labels haven't changed reference/value since last frame.
        let _lastSyncTuningRef = undefined;
        let _lastSyncBundleTuningRef = undefined;
        let _lastSyncCapo = NaN;
        let _lastSyncArrIdx = undefined;
        let _lastSyncPaletteRef = null;
        let _lastSyncNStr = -1;
        let _lastSyncTextSizeMul = NaN;
        let _lastSyncStartX = NaN;
        let _lastSyncLabelX = NaN;
        // Scratch Color used by _applyVibrancy() to avoid allocating a
        // fresh THREE.Color each time the user drags a slider.
        // Allocated lazily once Three.js is loaded inside initScene().
        let _paletteColorTmp = null;
        // Per-fret last-active timestamp for lane persistence
        let fretLastActiveTime = new Array(NFRETS + 1).fill(0);

        // Active string count for the current arrangement (resolved each
        // frame from bundle.stringCount and clamped to MAX_RENDER_STRINGS).
        let nStr = NSTR;
        // Set true once a chart with out-of-range s indices has triggered
        // its warning. Reset only on teardown or when nStr changes (e.g.
        // arrangement switch from guitar to bass) — same-nStr songs share
        // the suppression, which is fine for what is purely a developer
        // aid log.
        let _oobStringWarned = false;

        // Per-string bounds check used by every loop that indexes a
        // per-string array (noteState.*, nextNoteByString, lastFretForString,
        // mStr/mGlow/mSus, ...). Skipping out-of-range s upstream keeps
        // sparse-array extension out of those arrays AND keeps drawNote's
        // material lookup safe in one place.
        function validString(s) {
            const ok = Number.isInteger(s) && s >= 0 && s < nStr;
            if (!ok && !_oobStringWarned) {
                _oobStringWarned = true;
                let msg = '[3D-Hwy] dropping notes with s out of range [0,' + nStr + ')';
                if (nStr === S_COL.length) msg += ' (extended-range chart beyond palette size)';
                console.warn(msg);
            }
            return ok;
        }

        // filter() allocates a new array per chord per frame, even though
        // the vast majority of charts have no out-of-range strings. Scan
        // first; only allocate when there's actually something to drop.
        // The unfiltered array is reused as-is in the common case.
        function filterValidNotes(notes) {
            for (let i = 0; i < notes.length; i++) {
                if (!validString(notes[i].s)) {
                    return notes.filter(cn => validString(cn.s));
                }
            }
            return notes;
        }

        /** Normalized fingering signature for chord repeat-run detection, or null. */
        function chordShapeSignature(ch) {
            if (!ch?.notes) return null;
            const chordNotes = filterValidNotes(ch.notes);
            if (chordNotes.length === 0) return null;
            return chordNotes.slice().sort((a, b) => a.s - b.s).map(n => `${n.s}:${n.f}`).join('|');
        }

        // Camera state
        let _leftyCached = false;
        const xFret = f => (_leftyCached ? -fretX(f) : fretX(f));
        const xFretMid = f => (_leftyCached ? -fretMid(f) : fretMid(f));
        const boardSpanX = () => {
            const x0 = xFret(0);
            const xN = xFret(NFRETS);
            return {
                min: Math.min(x0, xN),
                max: Math.max(x0, xN),
                center: (x0 + xN) / 2,
                width: Math.abs(xN - x0),
            };
        };

        let tgtX = xFretMid(CAM_LOCK_CENTER_FRET), curX = xFretMid(CAM_LOCK_CENTER_FRET);
        let tgtDist = CAM_DIST_BASE, curDist = CAM_DIST_BASE;
        // Last committed lowFretBonus contribution baked into tgtDist
        // (see candidateDist block — bonus is applied on top of the
        // hysteresis-gated base).
        let prevLowFretBonus = 0;
        // Tracks whether the camera lock was active on the previous
        // frame, so the dynamic branch can bypass zoom hysteresis on
        // the first frame after a lock release. Without this, a >12
        // fret note that disengaged the lock could be swallowed by
        // the dead zone and the camera would fail to widen — a UX
        // promise of the lock toggle.
        let prevLockActive = false;
        let tgtLookY = 0, curLookY = 0;   // lerped look-at Y for self-correcting camera
        let aspectScale = 1;
        // _camSnapped / _camPreScanned / _songKey: together they gate the first-data snap.
        //
        // On the first update() frame where bundle.notes is available,
        // _camPreScanned is set and the full notes array is scanned (O(N), once)
        // to check whether ANY fretted note (f > 0) exists.  If none do (e.g. an
        // all-open-string bass arrangement), _camSnapped is set to true immediately
        // so the per-frame pre-pass is disabled for the entire song.
        //
        // For charts that do have fretted notes, a lightweight O(window) pre-pass
        // runs before any drawNote() call on every frame until the first frame
        // where fretted notes appear in the camera targeting window (preWSum > 0).
        // At that point curX/curDist are snapped directly to the computed targets,
        // eliminating the camera swoop for songs with long silent intros.
        //
        // Once _camSnapped is true it is never cleared for the current song; the
        // pre-pass is a permanent no-op thereafter and the camera reverts to
        // normal lerp-based tracking for the rest of the song.
        //
        // _songKey tracks the active song/arrangement so the snap state resets
        // automatically when the user switches songs or arrangements via
        // reconnect() (which does not call renderer.destroy/init).
        let _camSnapped = false;
        let _camPreScanned = false;
        let _songKey = null;
        // Smooth lookahead camera: fused world-X and displayed fret-span.
        let _lookaheadCamX = xFretMid(CAM_LOCK_CENTER_FRET);
        let _lookaheadFretSpan = DEFAULT_LOOKAHEAD_FRET_SPAN;
        let _lookaheadCamPrevNow = null;
        let _lookaheadLowBonusU = 0;
        let _lookaheadHiNeckLatch = false;

        // Lifecycle flags
        let _isReady = false;
        let _destroyed = false;
        let _invertedCached = false;
        let _invertedForBoard = false;
        let _leftyForBoard = false;
        let _initToken = 0;
        let highwayCanvas = null;

        // ── Focus state (splitscreen dim) ─────────────────────────────────
        let _focusSubscribed = false;
        let _isFocused = true;
        const _onFocusChange = () => _updateFocusState();

        function _unsubscribeFocus() {
            if (!_focusSubscribed) return;
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') ss.offFocusChange(_onFocusChange);
            _focusSubscribed = false;
        }

        function _updateFocusState() {
            if (_destroyed || !_isReady) return;
            const focused = _ssIsCanvasFocused(highwayCanvas);
            if (focused === _isFocused) return;
            _isFocused = focused;
            if (ambLight) ambLight.intensity = focused ? 0.85 : 0.4;
            if (dirLight) dirLight.intensity = focused ? 0.8 : 0.35;
        }

        // ── String-to-Y (respects invert) ─────────────────────────────────
        const sY = s => S_BASE + (_invertedCached ? s : (nStr - 1 - s)) * S_GAP;

        // ── Text-sprite cache ──────────────────────────────────────────────
        // ── Text-sprite style presets ─────────────────────────────────────
        // Each preset describes how a class of label is rasterised.
        // Tweak per-class look here (font, outline color/width, source
        // canvas size). `wide` toggles a long aspect ratio for multi-char
        // labels (chord/section names, "↑1/2", "~~~").
        //
        // Knobs:
        //   font        — full CSS font shorthand (weight + size + family)
        //   wideFont    — same, used when caller passes wide=true
        //   srcH        — source-canvas height in px (square; wide=4×).
        //                 Keep power-of-two so WebGL1 / Three.js retain
        //                 mipmaps + linear-mip-linear filtering — NPOT
        //                 textures silently fall back to no-mipmap and
        //                 shimmer at distance.
        //   stroke      — outline color (null = no outline)
        //   strokeW     — outline line-width in source-canvas px
        //   shadow      — { color, blur, dx, dy } or null
        const TXT_STYLES = {
            // The two fret-number sets the user wants to pop hardest.
            fretRow: {
                font:     '900 160px "Arial Black", "Helvetica Neue", Arial, sans-serif',
                wideFont: '900 128px "Arial Black", "Helvetica Neue", Arial, sans-serif',
                srcH: 256, stroke: '#0a1018', strokeW: 18,
                shadow: { color: 'rgba(0,0,0,0.7)', blur: 14, dx: 0, dy: 0 },
            },
            noteFret: {
                font:     '900 160px "Arial Black", "Helvetica Neue", Arial, sans-serif',
                wideFont: '900 128px "Arial Black", "Helvetica Neue", Arial, sans-serif',
                srcH: 256, stroke: '#0a1018', strokeW: 18,
                shadow: { color: 'rgba(0,0,0,0.7)', blur: 14, dx: 0, dy: 0 },
            },
            // Chord names — gold script-style label, lighter outline keeps
            // the colour readable.
            chord: {
                font:     'bold 80px sans-serif',
                wideFont: 'bold 64px sans-serif',
                srcH: 128, stroke: '#0a1018', strokeW: 6, shadow: null,
            },
            // Section banners ("Verse", "Chorus") — same as chord weight.
            section: {
                font:     'bold 80px sans-serif',
                wideFont: 'bold 64px sans-serif',
                srcH: 128, stroke: '#0a1018', strokeW: 6, shadow: null,
            },
            // Technique markers (pinch-harmonic icon, PM, AC, H/P/T, etc.).
            technique: {
                font:     'bold 80px sans-serif',
                wideFont: 'bold 64px sans-serif',
                srcH: 128, stroke: '#0a1018', strokeW: 6, shadow: null,
            },
            // Open-string "0" label on the note body itself.
            open: {
                font:     'bold 80px sans-serif',
                wideFont: 'bold 64px sans-serif',
                srcH: 128, stroke: '#0a1018', strokeW: 6, shadow: null,
            },
        };

        function txtMat(text, col, wide, style) {
            const sName = style || 'technique';
            const k = sName + '|' + (wide ? 'W' : '') + text + '|' + col;
            if (txtCache[k]) return txtCache[k];
            const sp = TXT_STYLES[sName] || TXT_STYLES.technique;
            const h  = sp.srcH;
            const str = String(text);
            const font = wide ? sp.wideFont : sp.font;

            let w = wide ? h * 4 : h;

            if (!wide && sName === 'noteFret') {
                // Wide labels (D#2, Bb3) need a canvas wider than srcH; cap so
                // glyphs stay centred at (w/2, h/2) without edge clipping.
                const probe = document.createElement('canvas').getContext('2d');
                probe.font = font;
                const tw = probe.measureText(str).width;
                let pad = 0;
                if (sp.stroke && sp.strokeW > 0) pad += sp.strokeW * 2;
                if (sp.shadow) {
                    pad += Math.abs(sp.shadow.dx) + sp.shadow.blur * 2;
                }
                w = Math.min(12 * h, Math.max(h, Math.ceil(tw + pad)));
            }

            const c  = document.createElement('canvas');
            c.width = w; c.height = h;
            const x = c.getContext('2d');
            x.font = font;
            // Fret / open-string digits: anchor from actualBoundingBox so the
            // glyph sits at the true optical centre of the canvas (fixes
            // sprites looking off-centre inside the board ghost and elsewhere).
            const inkCenterFret = !wide && (sName === 'noteFret' || sName === 'open');
            let drawX = w / 2;
            let drawY = h / 2;
            if (inkCenterFret) {
                x.textAlign = 'left';
                x.textBaseline = 'alphabetic';
                const m = x.measureText(str);
                const L = m.actualBoundingBoxLeft;
                const R = m.actualBoundingBoxRight;
                const A = m.actualBoundingBoxAscent;
                const D = m.actualBoundingBoxDescent;
                if (
                    L != null && R != null && A != null && D != null &&
                    Number.isFinite(L) && Number.isFinite(R) &&
                    Number.isFinite(A) && Number.isFinite(D)
                ) {
                    const inkW = R - L;
                    drawX = (w - inkW) / 2 - L;
                    drawY = (h + A - D) / 2;
                    // Tab digits sit visually a hair low vs bbox (stroke/shadow);
                    // small canvas nudge keeps sprites centred on the board ghost.
                    if (sName === 'noteFret') drawY -= h * 0.028;
                } else {
                    x.textAlign = 'center';
                    x.textBaseline = 'middle';
                    drawX = w / 2;
                    drawY = h / 2;
                }
            } else {
                x.textAlign = 'center';
                x.textBaseline = 'middle';
            }
            if (sp.shadow) {
                x.shadowColor   = sp.shadow.color;
                x.shadowBlur    = sp.shadow.blur;
                x.shadowOffsetX = sp.shadow.dx;
                x.shadowOffsetY = sp.shadow.dy;
            }
            if (sp.stroke && sp.strokeW > 0) {
                x.lineJoin    = 'round';
                x.miterLimit  = 2;
                x.strokeStyle = sp.stroke;
                x.lineWidth   = sp.strokeW;
                x.strokeText(str, drawX, drawY);
            }
            x.fillStyle = col;
            x.fillText(str, drawX, drawY);
            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c),
                transparent: true,
                // depthTest:false means later geometry never *fails* depth
                // against these sprites, but without depthWrite:false the
                // sprites still write to the depth buffer (Three.js default
                // is depthWrite:true even for SpriteMaterial). That can
                // make subsequent sprites/labels vanish — match the
                // pattern used by the other sprite materials in this file.
                depthTest: false,
                depthWrite: false,
            });
            txtCache[k] = mat;
            return mat;
        }

        function pinchHarmonicMat(col) {
            const baseCol = new T.Color(col != null ? col : '#ffd84d');
            // v5 — compact concentric ellipses:
            //   1. black outer border  rx=0.430h ry=0.255h
            //   2. string-color body   rx=0.418h ry=0.232h
            //   3. black inner ring    rx=0.407h ry=0.218h
            //   4. string-color inner  rx=0.264h ry=0.218h
            //   5. black center dot    rx=0.134h ry=0.120h
            const k = 'technique|pinchHarmonicIcon|rs2014-v5b|' + baseCol.getHexString();
            if (txtCache[k]) return txtCache[k];

            const h = 512;
            const c = document.createElement('canvas');
            c.width = h; c.height = h;
            const x = c.getContext('2d');
            const TAU = Math.PI * 2;
            const colStr = `rgb(${Math.round(baseCol.r * 255)},${Math.round(baseCol.g * 255)},${Math.round(baseCol.b * 255)})`;

            x.clearRect(0, 0, h, h);
            x.save();
            x.translate(h / 2, h / 2);

            // Form 1 — black outer border
            x.fillStyle = '#000000';
            x.beginPath(); x.ellipse(0, 0, h * 0.430, h * 0.255, 0, 0, TAU); x.fill();

            // Form 2 — string-color main body
            x.fillStyle = colStr;
            x.beginPath(); x.ellipse(0, 0, h * 0.418, h * 0.232, 0, 0, TAU); x.fill();

            // Form 3 — black inner ring
            x.fillStyle = '#000000';
            x.beginPath(); x.ellipse(0, 0, h * 0.407, h * 0.218, 0, 0, TAU); x.fill();

            // Form 4 — string-color inner spot (narrower)
            x.fillStyle = colStr;
            x.beginPath(); x.ellipse(0, 0, h * 0.2637, h * 0.218, 0, 0, TAU); x.fill();

            // Form 5 — black center dot
            x.fillStyle = '#000000';
            x.beginPath(); x.ellipse(0, 0, h * 0.134, h * 0.120, 0, 0, TAU); x.fill();

            x.restore();

            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c),
                transparent: true,
                depthTest: false,
                depthWrite: false,
            });
            txtCache[k] = mat;
            return mat;
        }

        function naturalHarmonicMat() {
            const k = 'technique|naturalHarmonicIcon|pink-ring-v3';
            if (txtCache[k]) return txtCache[k];

            const h = 256;
            const c = document.createElement('canvas');
            c.width = h; c.height = h;
            const x = c.getContext('2d');
            const cx = h / 2;
            const cy = h / 2;
            const TAU = Math.PI * 2;

            x.clearRect(0, 0, h, h);

            const glow = x.createRadialGradient(cx, cy, h * 0.03, cx, cy, h * 0.47);
            glow.addColorStop(0, 'rgba(255,170,255,0.14)');
            glow.addColorStop(0.55, 'rgba(0,0,0,0.22)');
            glow.addColorStop(1, 'rgba(0,0,0,0)');
            x.fillStyle = glow;
            x.beginPath();
            x.arc(cx, cy, h * 0.44, 0, TAU);
            x.fill();

            x.shadowColor = 'rgba(0,0,0,0.85)';
            x.shadowBlur = 14;
            x.fillStyle = 'rgba(255, 255, 255, 0.96)';
            x.beginPath();
            x.arc(cx, cy, h * 0.31, 0, TAU);
            x.fill();

            // Punch out the inner gap so the icon reads as a bright ring.
            x.shadowBlur = 0;
            x.globalCompositeOperation = 'destination-out';
            x.beginPath();
            x.arc(cx, cy, h * 0.20, 0, TAU);
            x.fill();
            x.globalCompositeOperation = 'source-over';

            x.shadowColor = 'rgba(0, 0, 0, 0.7)';
            x.shadowBlur = 10;
            x.strokeStyle = 'rgba(255, 255, 255, 0.98)';
            x.lineWidth = 8;
            x.beginPath();
            x.arc(cx, cy, h * 0.255, 0, TAU);
            x.stroke();

            x.shadowColor = 'rgba(0,0,0,0)';
            x.fillStyle = 'rgba(255, 255, 255, 0.98)';
            x.beginPath();
            x.arc(cx, cy, h * 0.12, 0, TAU);
            x.fill();

            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c),
                transparent: true,
                depthTest: false,
                depthWrite: false,
                opacity: 0.96,
            });
            txtCache[k] = mat;
            return mat;
        }

        function muteXMat(fillCol, strokeCol) {
            const k = 'technique|muteX|v2|' + String(fillCol) + '|' + String(strokeCol);
            if (txtCache[k]) return txtCache[k];

            // lineCap:'square' gives flat tips. For a 45° diagonal the square-cap
            // corners sit at ±outerW/2 rotated 45° from the endpoint — they land
            // outside the canvas unless pad ≥ outerW/√2 (the common mistake is
            // using outerW/2, which is too small). With the correct pad the white
            // cap is fully inside the canvas and the border is visible at every tip.
            const h = 512;
            const outerW = 132, innerW = 114;
            // pad must satisfy: pad ≥ outerW / Math.SQRT2  (≈ outerW × 0.707)
            const pad = Math.ceil(outerW / Math.SQRT2) + 2; // 96
            const c = document.createElement('canvas');
            c.width = h; c.height = h;
            const x = c.getContext('2d');

            x.clearRect(0, 0, h, h);
            x.lineCap = 'square';

            // Draw each diagonal in its own stroke() call — caps of the two
            // diagonals don't interact, and the white outer is drawn before the
            // black inner so the border is clean at every edge and tip.
            x.strokeStyle = strokeCol;
            x.lineWidth = outerW;
            x.beginPath(); x.moveTo(pad, pad); x.lineTo(h - pad, h - pad); x.stroke();
            x.beginPath(); x.moveTo(h - pad, pad); x.lineTo(pad, h - pad); x.stroke();

            x.strokeStyle = fillCol;
            x.lineWidth = innerW;
            x.beginPath(); x.moveTo(pad, pad); x.lineTo(h - pad, h - pad); x.stroke();
            x.beginPath(); x.moveTo(h - pad, pad); x.lineTo(pad, h - pad); x.stroke();

            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c),
                transparent: true,
                depthTest: false,
                depthWrite: false,
            });
            txtCache[k] = mat;
            return mat;
        }

        // Technique-marker sprite materials (triangle / chevron). Keyed by a
        // packed NUMBER, not a string — triMat/bendChevronMat are called from
        // the drawNote hot path, so a string cache key would allocate per
        // note per frame. Disposed in teardown. `hex` is a 0xRRGGBB number;
        // the low nibble of the key tags the variant (0 ▲, 1 ▼, 3-6 chevron
        // step-count) so triangle and chevron entries can't collide.
        const _techMatCache = new Map();

        // Hammer-on / pull-off triangle marker: a white ▲ (up) / ▼ (down)
        // with a thick border in the gem's string colour.
        function triMat(up, hex) {
            const h = (hex >>> 0) & 0xffffff;
            const key = h * 16 + (up ? 0 : 1);
            const cached = _techMatCache.get(key);
            if (cached) return cached;
            const S = 256, m = S * 0.15;
            const c = document.createElement('canvas');
            c.width = c.height = S;
            const g = c.getContext('2d');
            g.beginPath();
            if (up) { g.moveTo(S / 2, m); g.lineTo(S - m, S - m); g.lineTo(m, S - m); }
            else    { g.moveTo(S / 2, S - m); g.lineTo(S - m, m); g.lineTo(m, m); }
            g.closePath();
            g.lineJoin = 'round';
            g.fillStyle = '#ffffff';
            g.fill();
            g.lineWidth = S * 0.122;
            g.strokeStyle = '#' + (hex >>> 0).toString(16).padStart(6, '0');
            g.stroke();
            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c), transparent: true,
                depthTest: false, depthWrite: false,
            });
            _techMatCache.set(key, mat);
            return mat;
        }

        // Strength-of-bend chevron stack: `steps` (1-4) chevrons in the gem's
        // string colour (Rocksmith bend notation — 1 per half-step).
        function bendChevronMat(steps, hex) {
            const h = (hex >>> 0) & 0xffffff;
            const key = h * 16 + 2 + steps;   // steps 1-4 → low nibble 3-6
            const cached = _techMatCache.get(key);
            if (cached) return cached;
            const S = 256;
            const c = document.createElement('canvas');
            c.width = c.height = S;
            const g = c.getContext('2d');
            g.strokeStyle = '#' + (hex >>> 0).toString(16).padStart(6, '0');
            g.lineWidth = S * 0.10;
            g.lineJoin = g.lineCap = 'round';
            const padX = S * 0.18;
            const rowH = S / steps;
            const amp = Math.min(rowH * 0.55, S * 0.24);
            for (let i = 0; i < steps; i++) {
                const cy = (i + 0.5) * rowH;
                g.beginPath();
                g.moveTo(padX, cy + amp * 0.5);
                g.lineTo(S / 2, cy - amp * 0.5);
                g.lineTo(S - padX, cy + amp * 0.5);
                g.stroke();
            }
            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c), transparent: true,
                depthTest: false, depthWrite: false,
            });
            _techMatCache.set(key, mat);
            return mat;
        }

        /** MeshBasicMaterial sharing txtMat canvas texture — sits in board plane (not billboard). */
        function _meshMatForGhostFretDigit(spriteMat) {
            let mb = spriteMat.userData.h3dGhostFretMeshMat;
            if (!mb) {
                mb = new T.MeshBasicMaterial({
                    map: spriteMat.map,
                    transparent: true,
                    depthTest: false,
                    depthWrite: false,
                });
                spriteMat.userData.h3dGhostFretMeshMat = mb;
            }
            return mb;
        }

        /**
         * Convert any SpriteMaterial to a MeshBasicMaterial that shares its canvas
         * texture, so technique markers can be applied to a rotatable PlaneGeometry
         * mesh instead of a billboard Sprite. Cached on userData to avoid allocations.
         */
        function _spriteMat2MeshMat(mesh, sm) {
            // Cache the cloned MeshBasicMaterial on the receiving mesh so the
            // same mesh–sprite pairing reuses one material object across frames
            // instead of allocating a new clone every frame (unbounded growth).
            // The clone is invalidated only when the source sprite's map changes
            // (different technique or colour). Opacity is always set by the
            // caller immediately after, so stale-value risk is zero.
            const cached = mesh.userData.h3dTechMeshMatClone;
            if (cached && cached.map === sm.map) return cached;
            // Source texture changed or first call for this mesh — dispose old.
            if (cached) {
                _techMeshMatClones.delete(cached);
                cached.dispose();
                mesh.userData.h3dTechMeshMatClone = null;
            }
            let base = sm.userData.h3dTechMeshMat;
            if (!base) {
                base = new T.MeshBasicMaterial({
                    map: sm.map,
                    transparent: true,
                    depthTest: false,
                    depthWrite: false,
                    side: T.DoubleSide,
                });
                sm.userData.h3dTechMeshMat = base;
            }
            // First conversion for this mesh: the pTechPlane pool factory gave
            // it a placeholder MeshBasicMaterial that the caller is about to
            // overwrite with the clone below. Dispose it now — once
            // mesh.material is reassigned the placeholder is orphaned and
            // teardown's scene.traverse() pass can no longer reach it, so it
            // would leak one GPU material per pooled mesh for the renderer's
            // lifetime.
            if (!cached && mesh.material && mesh.material !== base) {
                mesh.material.dispose?.();
            }
            const clone = base.clone();
            mesh.userData.h3dTechMeshMatClone = clone;
            _techMeshMatClones.add(clone);
            return clone;
        }

        function _disposeOpenStringPitchSprites() {
            // Tuning-label materials are clones of cached txtMat() entries, so
            // they share the .map (CanvasTexture) with the canonical txtCache
            // material. Disposing the map here would invalidate every other
            // material that references the same cached glyph; teardown()'s
            // txtCache loop is the single owner of those textures.
            for (const m of _tuningLabelMats) {
                try { m.dispose(); } catch (_) { /* idempotent */ }
            }
            _tuningLabelMats = [];
            _tuningLabelSprites = [];
            _lastOpenStringLblSig = '';
            if (!tuningLblG) return;
            while (tuningLblG.children.length) tuningLblG.remove(tuningLblG.children[0]);
        }

        function _openStringLabelSignature(bundle, labels) {
            const si = bundle && bundle.songInfo;
            const tun = si && si.tuning;
            let tStr = '';
            if (Array.isArray(tun)) tStr = tun.slice(0, labels.length).join(',');
            else if (bundle && Array.isArray(bundle.tuning)) tStr = bundle.tuning.slice(0, labels.length).join(',');
            const capo =
                si && Number.isFinite(si.capo) ? si.capo
                    : (bundle && Number.isFinite(bundle.capo) ? bundle.capo : '');
            const arrIdx = si && si.arrangement_index != null ? si.arrangement_index : '';
            let palSig = '';
            const nLab = labels.length;
            if (activePalette) {
                // activePalette entries are numeric hex (PALETTES) or already hex strings;
                // convert without instantiating T.Color per string — this signature is
                // built every frame inside _syncOpenStringPitchLabels.
                const lim = Math.min(activePalette.length, nLab);
                for (let i = 0; i < lim; i++) {
                    if (i > 0) palSig += '/';
                    const c = activePalette[i];
                    palSig += typeof c === 'number' ? (c >>> 0).toString(16) : String(c);
                }
            }
            return `${nStr}|${capo}|${tStr}|${arrIdx}|${labels.join(',')}|${palSig}|${_textSizeMul.toFixed(3)}|${boardStringStartX.toFixed(6)}|${boardTuningLabelX.toFixed(6)}`;
        }

        function _syncOpenStringPitchLabels(bundle) {
            if (!tuningLblG || !T || !bundle) return;
            if (!tuningLabelsVisible) {
                tuningLblG.visible = false;
                if (_tuningLabelSprites.length) _disposeOpenStringPitchSprites();
                _lastOpenStringLblSig = '';
                return;
            }
            tuningLblG.visible = true;
            // Cheap-key fast path: compare the inputs that drive the label content
            // against last frame. The signature string + labels array build are
            // both per-frame allocators, so skipping them when nothing changed
            // saves a chunk of GC pressure in the hot render loop.
            const si = bundle.songInfo;
            const tunRef = (si && Array.isArray(si.tuning)) ? si.tuning : null;
            const bundleTunRef = Array.isArray(bundle.tuning) ? bundle.tuning : null;
            const capo =
                si && Number.isFinite(si.capo) ? si.capo
                    : (Number.isFinite(bundle.capo) ? bundle.capo : NaN);
            const arrIdx = si && si.arrangement_index != null ? si.arrangement_index : undefined;
            if (
                _tuningLabelSprites.length === nStr &&
                _lastSyncTuningRef === tunRef &&
                _lastSyncBundleTuningRef === bundleTunRef &&
                Object.is(_lastSyncCapo, capo) &&
                _lastSyncArrIdx === arrIdx &&
                _lastSyncPaletteRef === activePalette &&
                _lastSyncNStr === nStr &&
                _lastSyncTextSizeMul === _textSizeMul &&
                _lastSyncStartX === boardStringStartX &&
                _lastSyncLabelX === boardTuningLabelX
            ) return;
            // One of the inputs changed — fall through to the canonical signature
            // check (catches value-equal-but-different-ref tuning arrays).
            const labels = _openStringPitchLabelsForTuning(bundle, si, nStr);
            const sig = _openStringLabelSignature(bundle, labels);
            // Refresh cheap-key cache regardless of signature outcome so future
            // frames can fast-path even when the sig matched.
            _lastSyncTuningRef = tunRef;
            _lastSyncBundleTuningRef = bundleTunRef;
            _lastSyncCapo = capo;
            _lastSyncArrIdx = arrIdx;
            _lastSyncPaletteRef = activePalette;
            _lastSyncNStr = nStr;
            _lastSyncTextSizeMul = _textSizeMul;
            _lastSyncStartX = boardStringStartX;
            _lastSyncLabelX = boardTuningLabelX;
            if (sig === _lastOpenStringLblSig && _tuningLabelSprites.length === nStr) return;
            _disposeOpenStringPitchSprites();
            _lastOpenStringLblSig = sig;
            // Left of nut/cordas — centered on headstock mass so text does not sit on the strings.
            const labelX = boardTuningLabelX;
            const zLabel = -0.08 * K;
            const scalePx = 2.42 * _textSizeMul * K;
            for (let s = 0; s < nStr; s++) {
                const hex = '#' + new T.Color(activePalette[s % activePalette.length]).getHexString();
                const mat = txtMat(labels[s] || '?', hex, false, 'noteFret').clone();
                mat.depthTest = false;
                mat.depthWrite = false;
                mat.transparent = true;
                const sp = new T.Sprite(mat);
                sp.center.set(0, 0.5);
                sp.scale.set(scalePx, scalePx, 1);
                sp.position.set(labelX, sY(s), zLabel);
                sp.renderOrder = 8;
                tuningLblG.add(sp);
                _tuningLabelSprites.push(sp);
                _tuningLabelMats.push(mat);
            }
        }

        // ── Object pool ────────────────────────────────────────────────────
        function pool(parent, mk) {
            const a = [];
            let n = 0;
            return {
                get() {
                    if (n < a.length) {
                        const o = a[n++];
                        o.visible = true;
                        if (o.center && o.center.isVector2) o.center.set(0.5, 0.5);
                        return o;
                    }
                    const o = mk(); parent.add(o); a.push(o); n++; return o;
                },
                reset() { for (let i = 0; i < a.length; i++) a[i].visible = false; n = 0; },
            };
        }

        // Returns the longest consecutive sub-array from a sorted integer array.
        // @param {number[]} sorted - Sorted array of column indices (e.g. fretted column indices).
        // @returns {number[]} The longest run where each element equals the previous + 1.
        function longestConsecutiveRun(sorted) {
            let best = [], cur = [];
            for (let i = 0; i < sorted.length; i++) {
                if (cur.length === 0 || sorted[i] === cur[cur.length - 1] + 1) {
                    cur.push(sorted[i]);
                } else {
                    if (cur.length > best.length) best = cur;
                    cur = [sorted[i]];
                }
            }
            return cur.length > best.length ? cur : best;
        }

        /* ── Lyrics overlay (2D canvas on top of WebGL) ─────────────────── */
        function drawChordDiagram(ctx, opts) {
            const {
                name, frets,
                opacity = 1,
                entranceT = 1.0,
                canvasW = 600, canvasH = 400,
                inverted = false,
                sizeSlider = 0.5,
                position = 'tl',
                nStr = 6,
                lyricsBottom = 0,
            } = opts;

            // Responsive sizing — CELL derived from panel height + user slider.
            // COLS is the resolved string count from the caller (via resolveStringCount)
            // so bass (4), extended (7/8) arrangements render correctly.
            const COLS = nStr, ROWS = 4;
            // Minimum column span required for PATH B (bracket extension / detection).
            // Math.min(COLS-1, 4) scales with string count:
            //   4-string bass → 3  (max possible span, so 2-4-4-2 shapes qualify)
            //   6-string      → 4  (excludes D major span=2 / common 2-string coincidences)
            //   8-string      → 4  (muted outer strings still leave span ≥ 4 for real barres)
            const MIN_BARRE_SPAN = Math.min(COLS - 1, 4);
            // Maps diagram column index → chord-template frets-array index.
            // Templates are high-e-first: frets[0]=high e, frets[COLS-1]=low E.
            // Non-inverted display (col 0 = high e): getStrIdx(0) = 0        → frets[0]      = high e.
            // Inverted display     (col 0 = low E):  getStrIdx(0) = COLS-1   → frets[COLS-1] = low E.
            const getStrIdx = col => inverted ? (COLS - 1 - col) : col;
            const sizeF  = DIAG_SIZE_MIN + (DIAG_SIZE_MAX - DIAG_SIZE_MIN) * sizeSlider;

            // startFret / isFirstPos must be known before CELL so that fretLabelW
            // can be measured and factored into the width cap.  The old
            // canvasW/(COLS+1.5) guard only approximated 2*PAD and ignored the
            // extra left padding reserved for non-first-position "Nfr" labels.
            const playedFrets = frets.filter(f => f > 0);
            const minFret     = playedFrets.length > 0 ? Math.min(...playedFrets) : 1;
            const startFret   = Math.max(1, minFret);
            const isFirstPos  = startFret === 1;

            // Phase 1 — height + hard-cap estimate, used only to size the label font.
            // Cap against the vertical space available below lyricsBottom so that the
            // diagram does not overflow into the lyrics banner on short split panels with
            // wrapped lyric rows.  Only top-corner positions can overlap the lyrics banner,
            // so lyricsBottom is only subtracted when position is 'tl' or 'tr'; for 'bl'
            // and 'br' the full canvas height is available.
            // Clamp to at least 1 so font/box calculations never receive 0-px input
            // on very short panels (e.g. tiny split cells < 44 px tall).
            const isTopCorner = position === 'tl' || position === 'tr';
            const availH  = canvasH - (isTopCorner ? lyricsBottom : 0);
            const cellEst = Math.max(1, Math.min(
                Math.round(availH * sizeF / (ROWS + 3)),
                DIAG_CELL_MAX,
            ));
            // Extra left padding for the "Nfr" label on non-first-position chords.
            // Measured with ctx.measureText at cellEst so the estimate is exact.
            let fretLabelW = 0;
            if (!isFirstPos) {
                // Measure inside a save/restore so this font assignment does not
                // leak to the caller (the outer ctx.save() happens after CELL is derived).
                ctx.save();
                ctx.font = `italic ${Math.round(cellEst * 0.55)}px sans-serif`;
                fretLabelW = Math.ceil(ctx.measureText(startFret + 'fr').width) + 6;
                ctx.restore();
            }

            // Phase 2 — final CELL: cap against panel height, hard max, and panel width.
            // Two width constraints are needed because PAD has a hard floor of 6:
            //   A) when PAD = CELL*0.65 (large CELL):  CELL*(COLS+0.3) + fretLabelW ≤ canvasW
            //   B) when PAD = 6 floor (small CELL):    CELL*(COLS-1)  + 12 + fretLabelW ≤ canvasW
            // Both are included so boxW ≤ canvasW in every regime.
            // fretLabelW was measured at cellEst ≥ CELL, so the cap is conservative.
            const CELL   = Math.max(1, Math.min(
                cellEst,
                Math.floor((canvasW - fretLabelW) / (COLS + 0.3)),
                Math.floor((canvasW - 2 * 6 - fretLabelW) / Math.max(1, COLS - 1)),
            ));
            const HEADER = Math.round(CELL * 1.6);
            const MARKER = Math.round(CELL * 0.7);
            const DOT_R  = CELL * 0.3;
            const PAD    = Math.max(6, Math.round(CELL * 0.65));
            const gridW  = CELL * (COLS - 1);
            const gridH  = CELL * ROWS;

            const PAD_L  = PAD + fretLabelW;

            const boxW   = gridW + PAD_L + PAD;
            const boxH   = HEADER + MARKER + gridH + PAD;

            // Anchor to chosen corner. Top positions get extra vertical offset
            // to clear the timeline plugin and song name displayed at the top.
            // lyricsBottom is the actual bottom Y of the lyrics banner (returned by
            // drawLyrics), so TOP_Y steps down past all lyric rows regardless of
            // how many wrap lines the current panel width produces.
            const E    = PAD;
            const TOP_Y = Math.round(Math.max(E + canvasH * 0.06, lyricsBottom + E));
            let bx, by;
            if      (position === 'tr') { bx = canvasW - boxW - E; by = TOP_Y; }
            else if (position === 'bl') { bx = E; by = canvasH - boxH - E; }
            else if (position === 'br') { bx = canvasW - boxW - E; by = canvasH - boxH - E; }
            else                        { bx = E; by = TOP_Y; }

            // Clamp so the box never bleeds off-canvas on narrow panels or wide string counts.
            bx = Math.max(0, Math.min(canvasW - boxW, bx));
            by = Math.max(0, Math.min(canvasH - boxH, by));

            // Guard: the canvasH–boxH clamp above can push `by` above lyricsBottom when
            // wrapped lyrics consume nearly the full panel height.  This applies to ALL
            // corner positions: a bottom-corner diagram anchored near the canvas bottom can
            // still reach up into the lyrics banner on very short or narrow panels where
            // boxH is larger than the space below the lyrics.  In those cases skip drawing
            // entirely rather than painting on top of the lyrics banner.
            if (lyricsBottom > 0 && by < lyricsBottom) return 0;

            const gx = bx + PAD_L, gy = by + HEADER + MARKER;

            // Ease-out quadratic entrance scale: 0.85 → 1.0.
            const scale = 1 - 0.15 * (1 - entranceT) * (1 - entranceT);

            ctx.save();
            ctx.globalAlpha = opacity;

            if (scale !== 1.0) {
                const cx = bx + boxW / 2, cy = by + boxH / 2;
                ctx.translate(cx, cy);
                ctx.scale(scale, scale);
                ctx.translate(-cx, -cy);
            }

            // Background + border.
            ctx.fillStyle = 'rgba(8, 14, 22, 0.88)';
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.stroke();

            // Split-root typography: "Dm7" → "D" large bold + "m7" smaller.
            const rootMatch = name.match(/^([A-G][#b]?)(.*)/);
            const root    = rootMatch ? rootMatch[1] : name;
            const quality = rootMatch ? rootMatch[2] : '';
            const rootSize = Math.round(CELL * 1.25);
            const qualSize = Math.round(rootSize * 0.65);
            ctx.textBaseline = 'middle';
            const nameY = by + HEADER * 0.55;
            ctx.font = `bold ${rootSize}px sans-serif`;
            const rootW = ctx.measureText(root).width;
            ctx.font = `${qualSize}px sans-serif`;
            const qualW = quality ? ctx.measureText(quality).width : 0;
            const nameBlockW = rootW + (quality ? qualW + 2 : 0);
            const nameStartX = bx + boxW / 2 - nameBlockW / 2;
            ctx.fillStyle = '#e8d080';
            ctx.font = `bold ${rootSize}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.fillText(root, nameStartX, nameY);
            if (quality) {
                ctx.font = `${qualSize}px sans-serif`;
                ctx.fillStyle = 'rgba(232,208,128,0.75)';
                ctx.fillText(quality, nameStartX + rootW + 2, nameY);
            }

            // Nut: CELL-proportional filled rect + subtle highlight line.
            // Thickness is 40% of CELL, floored at 2 px so it stays visible on
            // the smallest diagrams (CELL=1 on compact split panels).
            const NUT_H = Math.round(Math.max(2, CELL * 0.4));
            if (isFirstPos) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(gx, gy - NUT_H, gridW, NUT_H);
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillRect(gx, gy - NUT_H, gridW, Math.max(1, Math.round(NUT_H * 0.25)));
            }

            // Fret label for non-first-position chords.
            if (!isFirstPos) {
                ctx.fillStyle = 'rgba(220,200,120,0.9)';
                ctx.font = `italic ${Math.round(CELL * 0.55)}px sans-serif`;
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(startFret + 'fr', gx - 4, gy + CELL * 0.5);
            }

            // Fret lines.
            ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
            for (let r = (isFirstPos ? 1 : 0); r <= ROWS; r++) {
                ctx.beginPath();
                ctx.moveTo(gx, gy + r * CELL);
                ctx.lineTo(gx + gridW, gy + r * CELL);
                ctx.stroke();
            }

            // String lines with varying weight: low E heavier, high e lighter.
            // With getStrIdx(col) = col (non-inverted): col 0 (high e) → strIdx=0 → t=0 thin;
            // col COLS-1 (low E) → strIdx=COLS-1 → t=1 thick. Inverted mode naturally mirrors.
            // Weights scale with CELL so strings never bleed into adjacent columns on
            // small-CELL diagrams (e.g. CELL=1 on compact split panels).
            for (let col = 0; col < COLS; col++) {
                const strIdx = getStrIdx(col);
                const t = COLS > 1 ? strIdx / (COLS - 1) : 1;  // 1=low E (thick), 0=high e (thin); guard COLS=1
                ctx.lineWidth = Math.max(0.5, CELL * (0.05 + t * 0.10));
                ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                ctx.beginPath();
                ctx.moveTo(gx + col * CELL, gy);
                ctx.lineTo(gx + col * CELL, gy + ROWS * CELL);
                ctx.stroke();
            }

            // Barre detection — two complementary paths:
            //
            // PATH A (F-shape / mini-barre): at least two ADJACENT columns are at startFret.
            //   Bracket is initially set to the consecutive run's own endpoints (not the full
            //   startFretCols range) so isolated bass notes at the same fret can't pull the
            //   bracket across an open gap (e.g. "2 0 2 2 0 0" stays bracketed at cols 2..3).
            //
            // PATH B (full-span barre / extension):
            //   When PATH A fired: extend the bracket outward to the full outer startFret span
            //     if the span ≥ MIN_BARRE_SPAN and every column between the outer startFret
            //     columns is fretted (f > 0).
            //   When PATH A did NOT fire: detect standalone full barres (e.g. x24442, x46654)
            //     where only the two outermost strings sit at startFret.  An additional check
            //     ensures that no intermediate column is itself at startFret — this rules out
            //     alternating-fret voicings like "1 3 1 3 1 0" (col 2 at startFret would fire
            //     incorrectly) while still catching B-major-style shapes where the barre
            //     finger covers only the outer two strings.
            //
            // Templates are high-e-first: frets[0]=high e, frets[COLS-1]=low E.
            // Examples (6-string, MIN_BARRE_SPAN=4):
            //   F major [1,1,2,3,3,1]: PATH A run=[4,5] → bracket 4..5; PATH B span=5, all fretted → extends to 0..5 ✓
            //   B major x24442:        PATH A no run; PATH B span=4, all fretted, no inner at startFret → 1..5 ✓
            //   mini-A  x02220:        PATH A run=[2,3,4] → bracket 2..4; PATH B span=2<4 → no extension ✓
            //   D major xx0232:        PATH A run length=1 → no PATH A; PATH B span<4 → no bracket ✓
            //   2 0 2 2 0 0:           PATH A run=[2,3] → bracket 2..3; PATH B span=3<4 → no extension ✓
            //   1 3 1 3 1 0:           PATH A no run; PATH B: inner col 2 at startFret → no bracket ✓
            const startFretCols = [];
            for (let col = 0; col < COLS; col++) {
                if (frets[getStrIdx(col)] === startFret) startFretCols.push(col);
            }
            const barreRun = longestConsecutiveRun(startFretCols);
            let hasBarreArc = barreRun.length >= 2;   // PATH A
            let barreMinCol = hasBarreArc ? barreRun[0] : -1;
            let barreMaxCol = hasBarreArc ? barreRun[barreRun.length - 1] : -1;

            if (startFretCols.length >= 2) {             // PATH B
                const minC = startFretCols[0];
                const maxC = startFretCols[startFretCols.length - 1];
                if (maxC - minC >= MIN_BARRE_SPAN) {
                    let allFretted = true;
                    for (let col = minC; col <= maxC; col++) {
                        if (frets[getStrIdx(col)] <= 0) { allFretted = false; break; }
                    }
                    if (allFretted) {
                        if (hasBarreArc) {
                            // PATH A fired: always safe to extend to full outer span.
                            barreMinCol = minC;
                            barreMaxCol = maxC;
                        } else {
                            // PATH A did not fire: only draw a bracket when no intermediate
                            // column sits at startFret.  Intermediate startFret columns would
                            // indicate a scattered/alternating voicing rather than a clean
                            // outer-edge barre (e.g. "1 3 1 3 1 0" has col 2 at startFret).
                            let noInnerAtStartFret = true;
                            for (let col = minC + 1; col < maxC; col++) {
                                if (frets[getStrIdx(col)] === startFret) { noInnerAtStartFret = false; break; }
                            }
                            if (noInnerAtStartFret) {
                                hasBarreArc = true;
                                barreMinCol = minC;
                                barreMaxCol = maxC;
                            }
                        }
                    }
                }
            }
            if (hasBarreArc) {
                const barreY   = gy + CELL * 0.5;
                const capH     = CELL * 0.22;  // vertical offset from barreY to the bracket line
                const capHalf  = Math.max(1, Math.round(CELL * 0.3)); // half-height of the vertical end caps
                // Straight bracket: a horizontal line with short vertical end caps.
                // Stroke scales with CELL so it doesn't swamp tiny cells (floor at 1 px).
                ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, CELL * 0.2);
                ctx.beginPath();
                ctx.moveTo(gx + barreMinCol * CELL, barreY - capH);
                ctx.lineTo(gx + barreMaxCol * CELL, barreY - capH);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(gx + barreMinCol * CELL, barreY - capH - capHalf);
                ctx.lineTo(gx + barreMinCol * CELL, barreY - capH + capHalf);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(gx + barreMaxCol * CELL, barreY - capH - capHalf);
                ctx.lineTo(gx + barreMaxCol * CELL, barreY - capH + capHalf);
                ctx.stroke();
            }

            // Open/muted markers + finger dots.
            // Non-inverted: col 0 = high e → getStrIdx(0)=0 → frets[0]; col COLS-1 = low E → frets[COLS-1].
            // Inverted:     col 0 = low E → getStrIdx(0)=COLS-1 → frets[COLS-1]; col COLS-1 = high e → frets[0].
            for (let col = 0; col < COLS; col++) {
                const f = frets[getStrIdx(col)];
                const sx = gx + col * CELL;
                const markerY = gy - MARKER * 0.5;
                if (f < 0) {
                    const r = CELL * 0.20;
                    ctx.strokeStyle = '#cc4444'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.moveTo(sx - r, markerY - r); ctx.lineTo(sx + r, markerY + r); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(sx + r, markerY - r); ctx.lineTo(sx - r, markerY + r); ctx.stroke();
                } else if (f === 0) {
                    ctx.strokeStyle = '#88bbff'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(sx, markerY, CELL * 0.22, 0, Math.PI * 2); ctx.stroke();
                } else {
                    const row = f - startFret;
                    if (row >= 0 && row < ROWS) {
                        const isBarreCol = hasBarreArc && f === startFret &&
                                           col >= barreMinCol && col <= barreMaxCol;
                        ctx.shadowColor = 'rgba(0,0,0,0.5)';
                        ctx.shadowBlur = Math.min(4, CELL * 0.4);
                        ctx.shadowOffsetX = Math.max(0.5, CELL * 0.1);
                        ctx.shadowOffsetY = Math.max(0.5, CELL * 0.1);
                        ctx.fillStyle = isBarreCol ? 'rgba(255,255,255,0.85)' : '#ffffff';
                        ctx.beginPath();
                        ctx.arc(sx, gy + row * CELL + CELL * 0.5, DOT_R, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
                        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                    }
                }
            }
            ctx.restore();
        }

        // Two-line section card. Top line is "Now: <current>", bottom line
        // is "Up Next: <next> in <countdown>". Explicit labels disambiguate
        // current vs upcoming — earlier single-line variant rendered both
        // states with the same word and was confusing during playback.
        //
        // Returns boxH on draw, 0 when nothing rendered. Position / size
        // mirror the chord-diagram contract: 'tl' / 'tr' / 'bl' / 'br'
        // anchor corners, sizeSlider in [0,1] scales card height.
        //
        // Hidden when:
        //   - no sections array, or
        //   - playback has not yet reached the first section AND there's
        //     no upcoming-only fallback rendered (we still show "Up Next"
        //     during the pre-roll so the user sees what's coming).
        function drawSectionHud(ctx, opts) {
            const {
                sections, currentTime,
                canvasW, canvasH,
                position = 'tr',
                sizeSlider = 0.5,
                lyricsBottom = 0,
            } = opts;
            if (!sections || !sections.length) return 0;

            // sections are time-ordered server-side; single forward scan.
            let curIdx = -1;
            for (let i = 0; i < sections.length; i++) {
                if (sections[i].time <= currentTime) curIdx = i;
                else break;
            }
            const cur  = curIdx >= 0 ? sections[curIdx] : null;
            const next = (curIdx + 1 < sections.length) ? sections[curIdx + 1] : null;
            // Pre-first-section: nothing playing yet but next is coming —
            // still useful to render "Up Next" alone so the user gets the
            // anticipatory cue during the song's intro silence.
            if (!cur && !next) return 0;

            const nowName = cur ? cur.name : '';
            // Render countdown as a separate span so it can take a calmer
            // grey-white treatment while the section name itself stays
            // cyan. Combining them into one string would inherit the cyan
            // fill across both, defeating the visual hierarchy promised
            // in the FR.
            let nextName = '';
            let nextCountdown = '';
            if (next) {
                const dt = next.time - currentTime;
                nextName = next.name;
                nextCountdown = dt > 10
                    ? 'in ' + Math.round(dt) + 's'
                    : 'in ' + Math.max(0, dt).toFixed(1) + 's';
            }

            const sizeF = 0.65 + 0.85 * sizeSlider; // 0.65 .. 1.5
            const baseH = Math.max(34, Math.min(72, Math.round(canvasH * 0.085 * sizeF)));
            const PAD_X = Math.round(baseH * 0.45);
            const PAD_Y = Math.round(baseH * 0.20);
            // Per-text-element scale applied to nameSize / tagSize / lineH
            // when the unscaled card would overflow a narrow panel
            // (splitscreen quad layout, ultra-tall portrait). Computed
            // below from the measured contentW vs the available width.
            let textScale = 1.0;
            const baseLineH    = Math.round(baseH * 0.46);
            const baseNameSize = Math.round(baseH * 0.36);
            const baseTagSize  = Math.round(baseH * 0.24);
            const baseTagGap   = Math.round(baseH * 0.14);

            const TAG_NOW  = 'Now:';
            const TAG_NEXT = 'Up Next:';

            // Phase-1 measurement at the unscaled font sizes — used to
            // decide whether textScale needs to drop, and to lay out the
            // final draw at whatever scale we land on.
            ctx.save();
            ctx.font = `${baseTagSize}px sans-serif`;
            const tagNowWBase  = ctx.measureText(TAG_NOW).width;
            const tagNextWBase = ctx.measureText(TAG_NEXT).width;
            const countdownWBase = nextCountdown ? ctx.measureText(nextCountdown).width : 0;
            ctx.font = `bold ${baseNameSize}px sans-serif`;
            const nowNameWBase  = nowName  ? ctx.measureText(nowName).width  : 0;
            const nextNameWBase = nextName ? ctx.measureText(nextName).width : 0;
            ctx.restore();

            const lineNowWBase  = nowName  ? tagNowWBase  + baseTagGap + nowNameWBase  : 0;
            const lineNextWBase = nextName
                ? tagNextWBase + baseTagGap + nextNameWBase
                  + (nextCountdown ? baseTagGap + countdownWBase : 0)
                : 0;
            const contentWBase  = Math.max(lineNowWBase, lineNextWBase);
            const numLines = (nowName ? 1 : 0) + (nextName ? 1 : 0);
            if (numLines === 0) return 0;

            // Target width budget: cap at canvasW - 16 and reserve PAD_X
            // either side. If contentWBase exceeds the budget, scale the
            // font proportionally — clamped to 0.55 so labels stay legible
            // even on extreme split-panel widths.
            const maxBoxW = Math.max(40, canvasW - 16);
            const availContentW = Math.max(1, maxBoxW - PAD_X * 2);
            if (contentWBase > availContentW) {
                textScale = Math.max(0.55, availContentW / contentWBase);
            }

            const lineH    = Math.max(1, Math.round(baseLineH    * textScale));
            const nameSize = Math.max(1, Math.round(baseNameSize * textScale));
            const tagSize  = Math.max(1, Math.round(baseTagSize  * textScale));
            const TAG_GAP  = Math.max(1, Math.round(baseTagGap   * textScale));

            // Phase-2 re-measurement at the scaled font sizes for the
            // final layout. measureText doesn't scale linearly with font
            // size on every glyph, so re-measuring is cheaper than
            // multiplying the base widths by textScale and risking a
            // half-pixel overflow.
            ctx.save();
            ctx.font = `${tagSize}px sans-serif`;
            const tagNowW  = ctx.measureText(TAG_NOW).width;
            const tagNextW = ctx.measureText(TAG_NEXT).width;
            const countdownW = nextCountdown ? ctx.measureText(nextCountdown).width : 0;
            ctx.font = `bold ${nameSize}px sans-serif`;
            const nowNameW  = nowName  ? ctx.measureText(nowName).width  : 0;
            const nextNameW = nextName ? ctx.measureText(nextName).width : 0;
            ctx.restore();

            const lineNowW  = nowName  ? tagNowW  + TAG_GAP + nowNameW  : 0;
            const lineNextW = nextName
                ? tagNextW + TAG_GAP + nextNameW + (nextCountdown ? TAG_GAP + countdownW : 0)
                : 0;
            const contentW = Math.max(lineNowW, lineNextW);

            const boxW = Math.min(maxBoxW, Math.round(contentW + PAD_X * 2));
            const boxH = Math.round(numLines * lineH + PAD_Y * 2);

            const E = Math.round(baseH * 0.25);
            const TOP_Y = Math.round(Math.max(E + canvasH * 0.06, lyricsBottom + E));
            let bx, by;
            if      (position === 'tr') { bx = canvasW - boxW - E; by = TOP_Y; }
            else if (position === 'bl') { bx = E; by = canvasH - boxH - E; }
            else if (position === 'br') { bx = canvasW - boxW - E; by = canvasH - boxH - E; }
            else                        { bx = E; by = TOP_Y; }
            bx = Math.max(0, Math.min(canvasW - boxW, bx));
            by = Math.max(0, Math.min(canvasH - boxH, by));
            // Suppress overlap with the wrapped lyrics banner regardless
            // of corner. Bottom-corner cards on short panels can still
            // reach up into the banner once boxH exceeds the space below
            // the lyrics — same shape the chord diagram uses.
            if (lyricsBottom > 0 && by < lyricsBottom) return 0;

            ctx.save();
            ctx.fillStyle = 'rgba(8, 14, 22, 0.88)';
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.stroke();

            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';

            // Layout each line with tag left-aligned, name in cyan after a
            // small gap. Both lines share the same x origin (bx + PAD_X)
            // so the tag column visually aligns vertically.
            const lineX = bx + PAD_X;
            let lineY = by + PAD_Y + lineH / 2;
            const TAG_COLOR = 'rgba(180,190,205,0.85)';
            const NAME_COLOR = '#00cccc';
            const TIME_COLOR = 'rgba(220,225,235,0.9)';

            if (nowName) {
                ctx.font = `${tagSize}px sans-serif`;
                ctx.fillStyle = TAG_COLOR;
                ctx.fillText(TAG_NOW, lineX, lineY);
                ctx.font = `bold ${nameSize}px sans-serif`;
                ctx.fillStyle = NAME_COLOR;
                ctx.fillText(nowName, lineX + tagNowW + TAG_GAP, lineY);
                lineY += lineH;
            }
            if (nextName) {
                ctx.font = `${tagSize}px sans-serif`;
                ctx.fillStyle = TAG_COLOR;
                ctx.fillText(TAG_NEXT, lineX, lineY);
                const nextX = lineX + tagNextW + TAG_GAP;
                ctx.font = `bold ${nameSize}px sans-serif`;
                ctx.fillStyle = NAME_COLOR;
                ctx.fillText(nextName, nextX, lineY);
                if (nextCountdown) {
                    ctx.font = `${tagSize}px sans-serif`;
                    ctx.fillStyle = TIME_COLOR;
                    ctx.fillText(nextCountdown, nextX + nextNameW + TAG_GAP, lineY);
                }
            }
            ctx.restore();
            return boxH;
        }

        function drawLyrics(lyrics, currentTime, ctx, W, H) {
            if (!lyrics._lines) {
                const lines = [];
                let line = null, word = null;
                const flushWord = () => { if (word && word.length) line.words.push(word); word = null; };
                const flushLine = () => { flushWord(); if (line && line.words.length) lines.push(line); line = null; };
                for (let i = 0; i < lyrics.length; i++) {
                    const l = lyrics[i];
                    const raw = l.w || '';
                    const endsLine = raw.endsWith('+');
                    const continuesWord = raw.endsWith('-');
                    if (line && i > 0 && l.t - (lyrics[i - 1].t + lyrics[i - 1].d) > 4.0) flushLine();
                    if (!line) line = { words: [], start: l.t, end: l.t + l.d };
                    if (!word) word = [];
                    word.push(l);
                    line.end = Math.max(line.end, l.t + l.d);
                    if (!continuesWord) flushWord();
                    if (endsLine) flushLine();
                }
                flushLine();
                lyrics._lines = lines;
            }
            const allLines = lyrics._lines;
            if (!allLines.length) return 0;

            let currentIdx = -1;
            for (let i = 0; i < allLines.length; i++) {
                if (allLines[i].start <= currentTime) currentIdx = i;
                else break;
            }
            if (currentIdx === -1) {
                if (allLines[0].start - currentTime > 2.0) return 0;
                currentIdx = 0;
            }
            const currentLine = allLines[currentIdx];
            const nextLine = allLines[currentIdx + 1] || null;
            const gapToNext = nextLine ? (nextLine.start - currentLine.end) : Infinity;
            if (currentTime > currentLine.end + 0.5 && gapToNext > 3.0) return 0;

            const linesToShow = [currentLine];
            if (nextLine && gapToNext <= 3.0) linesToShow.push(nextLine);

            const fontSize = Math.max(18, H * 0.028) | 0;
            const lineY = H * 0.04;
            const sylText = s => { const t = s.w || ''; return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t; };

            ctx.font = `bold ${fontSize}px sans-serif`;
            const spaceWidth = ctx.measureText(' ').width;
            const maxWidth = W * 0.8;

            const rows = [];
            for (const authoredLine of linesToShow) {
                let row = [], rowWidth = 0;
                for (const wordSyls of authoredLine.words) {
                    const parts = [];
                    let wordWidth = 0;
                    for (const s of wordSyls) {
                        const text = sylText(s);
                        const w = ctx.measureText(text).width;
                        parts.push({ syl: s, text, width: w });
                        wordWidth += w;
                    }
                    const advance = wordWidth + spaceWidth;
                    if (row.length > 0 && rowWidth + advance > maxWidth) { rows.push(row); row = []; rowWidth = 0; }
                    row.push({ parts, advance });
                    rowWidth += advance;
                }
                if (row.length) rows.push(row);
            }

            const rowHeight = fontSize + 6;
            const totalHeight = rows.length * rowHeight + 10;
            let bgWidth = 0;
            for (const row of rows) {
                const rw = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
                if (rw > bgWidth) bgWidth = rw;
            }
            bgWidth = Math.min(bgWidth + 30, W * 0.85);

            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.beginPath();
            const bx = W / 2 - bgWidth / 2, by = lineY - 4, br = 8;
            ctx.moveTo(bx + br, by); ctx.lineTo(bx + bgWidth - br, by);
            ctx.quadraticCurveTo(bx + bgWidth, by, bx + bgWidth, by + br);
            ctx.lineTo(bx + bgWidth, by + totalHeight - br);
            ctx.quadraticCurveTo(bx + bgWidth, by + totalHeight, bx + bgWidth - br, by + totalHeight);
            ctx.lineTo(bx + br, by + totalHeight);
            ctx.quadraticCurveTo(bx, by + totalHeight, bx, by + totalHeight - br);
            ctx.lineTo(bx, by + br);
            ctx.quadraticCurveTo(bx, by, bx + br, by);
            ctx.closePath();
            ctx.fill();

            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                const rowWidth = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
                let xPos = W / 2 - rowWidth / 2;
                const yPos = lineY + r * rowHeight + 2;
                for (const w of row) {
                    for (const part of w.parts) {
                        const l = part.syl;
                        const isActive = currentTime >= l.t && currentTime < l.t + l.d;
                        const isPast = currentTime >= l.t + l.d;
                        ctx.fillStyle = isActive ? '#4ae0ff' : isPast ? '#8899aa' : '#556677';
                        ctx.font = `${isActive ? 'bold' : 'normal'} ${fontSize}px sans-serif`;
                        ctx.fillText(part.text, xPos, yPos);
                        xPos += part.width;
                    }
                    xPos += spaceWidth;
                }
            }
            // Return the actual bottom Y of the rendered background box so callers
            // (e.g. drawChordDiagram) can avoid overlapping it.
            return Math.round(by + totalHeight);
        }

        /* ── Scene initialisation ─────────────────────────────────────────── */
        function initScene() {
            if (!highwayCanvas || !highwayCanvas.parentNode) {
                console.error('[3D-Hwy] initScene: canvas has no parent; aborting');
                return false;
            }

            // Reset per-song lane state
            fretLastActiveTime.fill(0);

            wrap = document.createElement('div');
            wrap.id = 'h3d-wrap-' + _instanceId;
            wrap.className = 'h3d-wrap';
            wrap.dataset.h3dInstance = String(_instanceId);
            const _controlsH = document.getElementById('player-controls')?.offsetHeight || 120;
            wrap.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:2;pointer-events:none;bottom:'
                + _controlsH + 'px;';
            // Mark this instance as the primary tour target so the tour engine
            // always spotlights a unique element (selector '.h3d-wrap[data-h3d-primary]')
            // rather than the first of potentially many splitscreen wraps.
            document.querySelectorAll('.h3d-wrap[data-h3d-primary]').forEach(
                el => el.removeAttribute('data-h3d-primary'));
            wrap.setAttribute('data-h3d-primary', '');
            highwayCanvas.parentNode.insertBefore(wrap, highwayCanvas.nextSibling);

            // Subscribe to highway:visibility (slopsmith#246) so the
            // .h3d-wrap overlay hides in sync with the slopsmith canvas.
            // The wrap is a sibling of #highway, so display:none on
            // #highway leaves us painting full-screen otherwise.
            // Guarded lazy bind: tolerate hosts that don't yet expose
            // slopsmith.on/off (older slopsmith versions, headless
            // tests).
            if (window.slopsmith
                && typeof window.slopsmith.on === 'function'
                && typeof window.slopsmith.off === 'function') {
                _visibilityHandler = (e) => {
                    if (!wrap) return;
                    // Filter by canvas identity (splitscreen-safe).
                    // Each createHighway() instance emits its own
                    // visibility events on the shared slopsmith bus —
                    // without this gate, one hidden panel would also
                    // hide every other panel's 3D overlay.
                    if (!e || !e.detail || e.detail.canvas !== highwayCanvas) return;
                    const v = e.detail.visible;
                    wrap.style.display = v === false ? 'none' : '';
                };
                try {
                    window.slopsmith.on('highway:visibility', _visibilityHandler);
                } catch (e) {
                    _visibilityHandler = null;
                }
                // Track canvas-replaced so the visibility handler's
                // identity gate continues to match after core swaps the
                // <canvas> element for a context-type change.
                _canvasReplacedHandler = (e) => {
                    if (!e || !e.detail) return;
                    // Only update if the swap involves OUR canvas — in
                    // splitscreen each panel has its own canvas.
                    if (e.detail.oldCanvas !== highwayCanvas) return;
                    highwayCanvas = e.detail.newCanvas;
                    // Re-sync wrap visibility from the new canvas in
                    // case its initial displayed-state differs.
                    if (wrap) {
                        const v = highwayCanvas && highwayCanvas.offsetParent !== null;
                        wrap.style.display = v ? '' : 'none';
                    }
                };
                try {
                    window.slopsmith.on('highway:canvas-replaced', _canvasReplacedHandler);
                } catch (e) {
                    _canvasReplacedHandler = null;
                }
                // Sync once at bind time: the event is transition-only,
                // so if the canvas was already hidden when we mounted
                // (e.g. plugin loaded while splitscreen was active),
                // we'd never receive an emit and would leave the wrap
                // visible. Compute from the local highwayCanvas (not
                // window.highway.isVisible) so splitscreen panels get
                // their own per-instance answer instead of inheriting
                // the main highway's state.
                if (_visibilityHandler) {
                    try {
                        const initialVisible = highwayCanvas
                            && highwayCanvas.offsetParent !== null;
                        wrap.style.display = initialVisible ? '' : 'none';
                    } catch (e) { /* ignore — initial sync is best-effort */ }
                }
            }

            ren = new T.WebGLRenderer({ antialias: true });
            _probe = new T.Vector3();
            _ghostLblBox = new T.Box3();
            _ghostLblMid = new T.Vector3();
            _ghostLblTowardCam = new T.Vector3();
            ren.setClearColor(0x101820);
            ren.domElement.style.pointerEvents = 'none';
            ren.domElement.style.zIndex = '1';
            wrap.appendChild(ren.domElement);

            lyricsCanvas = document.createElement('canvas');
            lyricsCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
            lyricsCtx = lyricsCanvas.getContext('2d');
            wrap.appendChild(lyricsCanvas);

            scene = new T.Scene();
            scene.fog = new T.Fog(0x101820, FOG_START * 0.8, FOG_END * 1.2);

            cam = new T.PerspectiveCamera(70, 1, 0.01, FOG_END * 3);

            ambLight = new T.AmbientLight(0xffffff, 0.85);
            scene.add(ambLight);
            dirLight = new T.DirectionalLight(0xffffff, 0.8);
            dirLight.position.set(40 * K, 120 * K, 80 * K);
            scene.add(dirLight);

            fretG = new T.Group(); scene.add(fretG);
            tuningLblG = new T.Group(); scene.add(tuningLblG);
            noteG = new T.Group(); scene.add(noteG);
            beatG = new T.Group(); scene.add(beatG);
            lblG = new T.Group(); scene.add(lblG);

            // Rectangular note geometry
            gNote = new T.BoxGeometry(NW, NH, ND);

            /** Filled ring matching flying-note outline (1.1) minus core (1.0); hollow centre. */
            function mkGhostFrameGeometry() {
                const ow = NW * 1.1;
                const oh = NH * 1.1;
                const iw = NW;
                const ih = NH;
                const depth = ND * 2.8;
                const shape = new T.Shape();
                shape.moveTo(-ow / 2, -oh / 2);
                shape.lineTo(-ow / 2, oh / 2);
                shape.lineTo(ow / 2, oh / 2);
                shape.lineTo(ow / 2, -oh / 2);
                shape.lineTo(-ow / 2, -oh / 2);
                const hole = new T.Path();
                hole.moveTo(-iw / 2, -ih / 2);
                hole.lineTo(iw / 2, -ih / 2);
                hole.lineTo(iw / 2, ih / 2);
                hole.lineTo(-iw / 2, ih / 2);
                hole.lineTo(-iw / 2, -ih / 2);
                shape.holes.push(hole);
                const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
                g.translate(0, 0, -depth / 2);
                return g;
            }

            gSus = new T.BoxGeometry(1, 1, 1);
            gBeat = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
            );
            // Tap chevron (open V pointing downward) — filled outline for extrusion into a solid mesh

            const chevronShape = new T.Shape();

            // Adjusting points for a "stubby" look
            // Width: increased to +/- 0.8 for a broader look
            // Height: capped at 0.2 to make it significantly shorter
            chevronShape.moveTo(-0.6, 0.3);   // Top left point (further out, lower down)
            chevronShape.lineTo(0, -0.1);     // Interior vertex (shallower V)
            chevronShape.lineTo(0.6, 0.3);    // Top right point (further out, lower down)

            chevronShape.lineTo(0.8, 0.0);    // Right outer thickness point
            chevronShape.lineTo(0, -0.3);     // Bottom vertex / Outer point (less deep)
            chevronShape.lineTo(-0.8, 0.0);   // Left outer thickness point

            chevronShape.closePath();

            // Create the 3D mesh geometry with a small depth
            gTapChevron = new T.ExtrudeGeometry(chevronShape, {
                depth: 0.04 * K,
                bevelEnabled: false,
            });

            // Optional: Center the geometry if the pivot point feels off
            gTapChevron.computeBoundingBox();
            const centerOffset = -0.5 * (gTapChevron.boundingBox.max.y + gTapChevron.boundingBox.min.y);
            gTapChevron.translate(0, centerOffset, 0);

            // String materials: emissive so they glow when lit
            mStr = activePalette.map(c => new T.MeshStandardMaterial({
                color: c, emissive: c, emissiveIntensity: 0.002,
                transparent: true, opacity: 0.4, roughness: 1,
            }));
            mGlow = activePalette.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
                transparent: true, opacity: 1.0, depthWrite: false,
            }));
            _laneTargetColor = new T.Color(0x4488ff);
            mSus = activePalette.map(c => new T.MeshLambertMaterial({
                color: c, transparent: true, opacity: 0.35,
            }));
            mWhiteOutline = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, transparent: true, opacity: 1.0, depthWrite: false });
            mStrHitOutline = activePalette.map(c => new T.MeshLambertMaterial({
                color: c, emissive: c, emissiveIntensity: 1.0,
                transparent: true, opacity: 1.0, depthWrite: false,
            }));
            // Stronger coloured rim + body for accented notes (.ac); drawNote swaps these in behind ND hit/miss.
            mAccentOutline = activePalette.map(c => new T.MeshLambertMaterial({
                color: c, emissive: c, emissiveIntensity: ACCENT_RIM_BASE_EMISSIVE,
                transparent: true, opacity: 1.0, depthWrite: false,
            }));
            // Same colour response as mGlow (vibrancy lerp) but separate emissive drive for extra accent punch.
            mAccentCore = activePalette.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
                transparent: true, opacity: 1.0, depthWrite: false,
            }));
            const mkAccentHaloMats = (baseOp) => activePalette.map(c => new T.MeshBasicMaterial({
                color: new T.Color(c),
                transparent: true,
                opacity: baseOp,
                depthWrite: false,
                depthTest: true,
                blending: T.AdditiveBlending,
                side: T.DoubleSide,
                fog: true,
            }));
            mAccentHaloNear = mkAccentHaloMats(ACCENT_HALO_OP_NEAR);
            mAccentHaloMid = mkAccentHaloMats(ACCENT_HALO_OP_MID);
            mAccentHaloFar = mkAccentHaloMats(ACCENT_HALO_OP_FAR);
            // Chord/arpeggio frame accent bloom — per-instance cloned materials
            // so near/far shells can have independent opacity values.
            // Shared unit-box geometry — pooled halo meshes are scaled/rotated
            // per draw, so one geometry serves the whole pool (same pattern as
            // gNote / gSusRailBloom). Materials stay per-instance below so each
            // accent shell can carry its own opacity.
            gChordAccentHalo = new T.BoxGeometry(1, 1, 1);
            pChordAccentHalo = pool(noteG, () => new T.Mesh(
                gChordAccentHalo,
                new T.MeshBasicMaterial({
                    transparent: true, opacity: 0.8, depthWrite: false,
                    blending: T.AdditiveBlending, side: T.DoubleSide, fog: true,
                }),
            ));
            // Notedetect feedback (issue #9): bright green / red outline
            // tints. Note rendering swaps its outline.material between
            // mWhiteOutline / mHitOutline / mMissOutline based on
            // recent notedetect events.
            mHitOutline = new T.MeshLambertMaterial({ color: 0x40ff70, emissive: 0x40ff70, emissiveIntensity: 1.0, transparent: true, opacity: 1.0, depthWrite: false });
            mMissOutline = new T.MeshLambertMaterial({ color: 0xff4040, emissive: 0xff4040, emissiveIntensity: 1.0, transparent: true, opacity: 1.0, depthWrite: false });
            // Dark charcoal core for missed gems: pairs with the red
            // mMissOutline ring to produce an "extinguished" gem look that
            // reads as a miss on every string, including those whose hue
            // is already red. Lower emissive than the outline so the ring
            // dominates and the gem reads as a dark body with a red rim.
            mMissCore = new T.MeshLambertMaterial({ color: 0x181818, emissive: 0x401010, emissiveIntensity: 0.4, transparent: true, opacity: 1.0, depthWrite: false });
            mSusOutline = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3, transparent: true, opacity: 0.75, depthWrite: false });
            mBeatM = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
            mBeatQ = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 });

            // ── Board ghost: filled rim (ExtrudeGeometry w/ hole) in string colour ──
            // Matches outline 1.1× vs core 1.0× like drawNote; centre stays empty.
            projMeshArr = activePalette.map((_, s) => {
                const geo = mkGhostFrameGeometry();
                const mat = new T.MeshStandardMaterial({
                    color: activePalette[s],
                    emissive: activePalette[s],
                    emissiveIntensity: 0.002,
                    transparent: true,
                    opacity: 0.65,
                    roughness: 1,
                    depthWrite: false,
                    depthTest: false,
                });
                const m = new T.Mesh(geo, mat);
                m.visible = false;
                // Board projection ghost frame. depthTest:false above, so
                // renderOrder alone decides stacking — keep it above the
                // chord frame (12/13) but below note gems (20/21) so it
                // stays visible on the fretboard without covering notes.
                m.renderOrder = 14;
                noteG.add(m);
                return m;
            });

            // ── Pools ──────────────────────────────────────────────────────
            pNote = pool(noteG, () => new T.Mesh(gNote, mStr[0]));
            pAccentHalo = pool(noteG, () => new T.Mesh(gNote, mAccentHaloFar[0]));
            pSus = pool(noteG, () => new T.Mesh(gSus, mSus[0]));
            pSusOutline = pool(noteG, () => new T.Mesh(gSus, mSusOutline));
            const mkSlideRibbonGeo = () => {
                const nVert = 4 * (SLIDE_RIBBON_SAMPLES + 1);
                const g = new T.BufferGeometry();
                g.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(nVert * 3), 3));
                // SLIDE_RIBBON_INDICES_ARR is the plain-Array form (see module-init
                // comment) shared across pool meshes; setIndex() rewraps it into a
                // fresh Uint16BufferAttribute per geometry, so the share is safe.
                g.setIndex(SLIDE_RIBBON_INDICES_ARR);
                // Static cross-section normals: each ring is an axis-aligned quad,
                // so vertex normals point radially in the XY plane regardless of
                // the slide's Z-direction curvature. Pre-fill once and skip the
                // per-frame computeVertexNormals() pass that previously ran on
                // every sustained-slide update (Copilot perf finding on PR #215).
                const SQRT_HALF = Math.SQRT1_2;
                const normals = new Float32Array(nVert * 3);
                for (let k = 0; k <= SLIDE_RIBBON_SAMPLES; k++) {
                    const o = k * 12;
                    // v0 (-X,-Y), v1 (+X,-Y), v2 (+X,+Y), v3 (-X,+Y)
                    normals[o]     = -SQRT_HALF; normals[o + 1]  = -SQRT_HALF; normals[o + 2]  = 0;
                    normals[o + 3] =  SQRT_HALF; normals[o + 4]  = -SQRT_HALF; normals[o + 5]  = 0;
                    normals[o + 6] =  SQRT_HALF; normals[o + 7]  =  SQRT_HALF; normals[o + 8]  = 0;
                    normals[o + 9] = -SQRT_HALF; normals[o + 10] =  SQRT_HALF; normals[o + 11] = 0;
                }
                g.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
                return g;
            };
            // Ribbon meshes mutate vertex positions every frame in
            // slideRibbonUpdatePositions but the mesh itself stays at (0,0,0)
            // and the geometry's bounding sphere is never recomputed. With
            // frustum culling on, Three.js tests the (0,0,0)-centred bounds
            // and culls the ribbon as soon as the camera pans away from world
            // origin, so slides flicker in/out. Disable culling on these
            // meshes — the ribbon footprint is small and they're already
            // gated by t0/t1 reachability before render.
            pSusRibbon = pool(noteG, () => {
                const m = new T.Mesh(mkSlideRibbonGeo(), mSus[0]);
                m.frustumCulled = false;
                return m;
            });
            pSusRibbonOl = pool(noteG, () => {
                const m = new T.Mesh(mkSlideRibbonGeo(), mSusOutline);
                m.frustumCulled = false;
                m.renderOrder = -3;
                return m;
            });
            // One shared material per technique-mesh type. The pool factory
            // hands out fresh meshes that all reference the same material,
            // so a dense HO/PO passage doesn't churn N MeshLambertMaterial
            // allocations and N GPU material switches.
            // Transparent + no depth write/test so the tap chevron draws in
            // the transparent pass where drawNote assigns renderOrder 1000.
            mTapChevron = new T.MeshLambertMaterial({
                color: 0xd4d4d4,
                emissive: 0xd4d4d4,
                emissiveIntensity: 0.9,
                transparent: true,
                opacity: 0.85,
                side: T.DoubleSide,
                depthWrite: false,
                depthTest: false,
            });
            pTapChevron = pool(noteG, () => new T.Mesh(gTapChevron, mTapChevron));
            pLbl  = pool(lblG,  () => new T.Sprite(txtMat('0', '#fff', false, 'technique')));
            pBeat = pool(beatG, () => new T.Line(gBeat, mBeatQ));
            pSec  = pool(lblG,  () => new T.Sprite(txtMat('', '#0dd', true, 'section')));

            // Chord sustain length indicator — thin horizontal plane rails.
            // Unit plane (1×1 in XZ) laid flat; scaled to (railWidth, 1, railLen).
            // A horizontal plane seen from the camera looking down-forward is
            // face-on and has real apparent thickness — unlike T.Line (always 1px).
            // depthTest:false so they never occlude gems; renderOrder 16 places
            // them behind notes (20/21) but in front of chord fill (10).
            gSusRail = new T.PlaneGeometry(1, 1);
            gSusRail.rotateX(-Math.PI / 2); // lay flat in XZ plane
            mSusRailBase = new T.MeshBasicMaterial({
                color: CHORD_BOX_TEAL_HEX,
                transparent: true, opacity: 0.85,
                depthTest: false, depthWrite: false,
                fog: false, side: T.DoubleSide,
            });
            pSusRail = pool(noteG, () => {
                const m = new T.Mesh(gSusRail, mSusRailBase.clone());
                m.renderOrder = 16;
                return m;
            });

            // Bloom glow for chord sustain rails — wider plane with a gaussian
            // falloff texture (bright centre → transparent edges in X direction)
            // and additive blending, so it brightens whatever is behind it.
            // renderOrder 14 places it behind the core rail (16).
            _bloomGaussTex = _makeGaussTex(T);
            gSusRailBloom = new T.PlaneGeometry(1, 1);
            gSusRailBloom.rotateX(-Math.PI / 2);
            mSusRailBloomBase = new T.MeshBasicMaterial({
                color: CHORD_BOX_TEAL_HEX,
                map: _bloomGaussTex,
                transparent: true, opacity: 0.55,
                blending: T.AdditiveBlending,
                depthTest: false, depthWrite: false,
                fog: false, side: T.DoubleSide,
            });
            pSusRailBloom = pool(noteG, () => {
                const m = new T.Mesh(gSusRailBloom, mSusRailBloomBase.clone());
                m.renderOrder = 14;
                return m;
            });

            // Rotatable plane pool for technique markers (pm, mt, hm, hp, H/P, bend).
            // Unlike T.Sprite, a PlaneGeometry mesh accepts rotation.z = approachRot
            // so markers stay coplanar with the gem as it tilts from vertical to flat.
            gTechPlane = new T.PlaneGeometry(1, 1);
            pTechPlane = pool(noteG, () => {
                const m = new T.Mesh(gTechPlane, new T.MeshBasicMaterial({
                    transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide,
                }));
                m.renderOrder = 1000;
                return m;
            });


            // Dynamic fret number labels (heat-coloured, updated each frame)
            pFretLbl = pool(lblG, () => new T.Sprite(txtMat('0', '#888', false, 'fretRow')));

            // Highlight lane plane over active fret range. With the anchor-driven
            // segmented lanes we render up to fret-count × HWY_LANE_TIME_SLICES (96)
            // pLane meshes per frame, so:
            //   - geometry is a shared PlaneGeometry(1,1) (was per-mesh, never differed)
            //   - 2 shared MeshBasicMaterials (odd / even stripe colour) replace the
            //     per-mesh material clones; the per-frame opacity still travels via
            //     the materials but is set once outside the inner loop, not per-mesh.
            gLanePlane = new T.PlaneGeometry(1, 1);
            mLaneOdd = new T.MeshBasicMaterial({
                color: HWY_LANE_STRIPE_ODD_HEX, transparent: true, opacity: 0, depthWrite: false,
            });
            mLaneEven = new T.MeshBasicMaterial({
                color: HWY_LANE_STRIPE_EVEN_HEX, transparent: true, opacity: 0, depthWrite: false,
            });
            // Tracked for explicit disposal in teardown — these materials may
            // not be reachable via scene.traverse() if no lane was ever rendered.
            _ownedSharedMats.push(mLaneOdd, mLaneEven);
            _ownedSharedGeos.push(gLanePlane);
            pLane = pool(noteG, () => new T.Mesh(gLanePlane, mLaneOdd));

            gGhostFretPlane = new T.PlaneGeometry(1, 1);
            _ownedSharedGeos.push(gGhostFretPlane);
            const mGhostFretLblPh = new T.MeshBasicMaterial({
                color: 0xffffff, transparent: true, depthTest: false, depthWrite: false,
            });
            _ownedSharedMats.push(mGhostFretLblPh);
            pGhostFretLbl = pool(noteG, () => {
                const m = new T.Mesh(gGhostFretPlane, mGhostFretLblPh);
                m.renderOrder = 3;
                m.frustumCulled = false;
                return m;
            });

            // Vertical fret dividers within active lane
            const gLaneDivider = new T.BoxGeometry(0.15 * K, 0.15 * K, 1);
            mLaneDivider = new T.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.08, fog: false, depthWrite: false,
            });
            mLaneDividerArp = new T.MeshBasicMaterial({
                color: ARPEGGIO_RIM_BLUE_HEX,
                transparent: true, opacity: 0.08, fog: false, depthWrite: false,
            });
            _ownedSharedMats.push(mLaneDivider, mLaneDividerArp);
            pLaneDivider = pool(noteG, () => new T.Mesh(gLaneDivider, mLaneDivider));

            // Chord frame palette (frame alpha 128, fill gradient alpha 32; MeshBasic).
            const chR = CHORD_BOX_TEAL_HEX >> 16 & 255;
            const chG = CHORD_BOX_TEAL_HEX >> 8 & 255;
            const chB = CHORD_BOX_TEAL_HEX & 255;
            const dkR = CHORD_BOX_TEAL_DARK_HEX >> 16 & 255;
            const dkG = CHORD_BOX_TEAL_DARK_HEX >> 8 & 255;
            const dkB = CHORD_BOX_TEAL_DARK_HEX & 255;
            const aFill = Math.round(CHORD_BOX_FILL_GRAD_ALPHA * 255);
            chordFrameGradTex = new T.DataTexture(
                new Uint8Array([ chR, chG, chB, aFill, dkR, dkG, dkB, aFill, chR, chG, chB, aFill ]),
                3, 1, T.RGBAFormat);
            chordFrameGradTex.magFilter = T.LinearFilter;
            chordFrameGradTex.minFilter = T.LinearFilter;
            chordFrameGradTex.wrapS = T.ClampToEdgeWrapping;
            chordFrameGradTex.wrapT = T.ClampToEdgeWrapping;
            // DataTexture defaults to linear color space; flag this gradient
            // as sRGB so the chord-box hex values match other sRGB color textures.
            chordFrameGradTex.colorSpace = T.SRGBColorSpace;
            chordFrameGradTex.needsUpdate = true;

            const arR = ARPEGGIO_BOX_BLUE_HEX >> 16 & 255;
            const arG = ARPEGGIO_BOX_BLUE_HEX >> 8 & 255;
            const arB = ARPEGGIO_BOX_BLUE_HEX & 255;
            const arDR = ARPEGGIO_BOX_BLUE_DARK_HEX >> 16 & 255;
            const arDG = ARPEGGIO_BOX_BLUE_DARK_HEX >> 8 & 255;
            const arDB = ARPEGGIO_BOX_BLUE_DARK_HEX & 255;
            chordFrameGradTexArp = new T.DataTexture(
                new Uint8Array([ arR, arG, arB, aFill, arDR, arDG, arDB, aFill, arR, arG, arB, aFill ]),
                3, 1, T.RGBAFormat);
            chordFrameGradTexArp.magFilter = T.LinearFilter;
            chordFrameGradTexArp.minFilter = T.LinearFilter;
            chordFrameGradTexArp.wrapS = T.ClampToEdgeWrapping;
            chordFrameGradTexArp.wrapT = T.ClampToEdgeWrapping;
            chordFrameGradTexArp.colorSpace = T.SRGBColorSpace;
            chordFrameGradTexArp.needsUpdate = true;

            pChordFrameFill = pool(noteG, () => new T.Mesh(
                new T.PlaneGeometry(1, 1),
                new T.MeshBasicMaterial({
                    map: chordFrameGradTex,
                    transparent: true,
                    opacity: 1,
                    depthWrite: false,
                    depthTest: false,
                    fog: false,
                    side: T.DoubleSide,
                }),
            ));
            pChordBox = pool(noteG, () => new T.Mesh(
                new T.BoxGeometry(1, 1, 1),
                new T.MeshBasicMaterial({
                    color: CHORD_BOX_TEAL_HEX,
                    transparent: true,
                    opacity: CHORD_BOX_EDGE_ALPHA,
                    depthWrite: false,
                    depthTest: false,
                    fog: false,
                    side: T.DoubleSide,
                }),
            ));

            // PM strum X fill — 4 corner regions + centre; the 4 arms (L,R,T,B) are left empty.
            // 16 vertices, 14 triangles.
            //  0=A(-1,1)  1=TLC(-0.48,1)  2=T(-0.012,0.257)  3=TRC(0.5,1)
            //  4=BR(1,1)  5=REB(1,0.5)   6=R(0.476,-0.011)  7=RET(1,-0.5)
            //  8=C(1,-1)  9=BRC(0.48,-1) 10=B(-0.003,-0.276) 11=BLC(-0.48,-1)
            // 12=D(-1,-1) 13=LET(-1,-0.5) 14=L(-0.494,-0.011) 15=LEB(-1,0.5)
            {
                // prettier-ignore
                const pos = new Float32Array([
                    -1,      1,      0,  //  0  A
                    -0.480,  1,      0,  //  1  TLC
                    -0.012,  0.257,  0,  //  2  T
                     0.500,  1,      0,  //  3  TRC
                     1,      1,      0,  //  4  BR
                     1,      0.5,    0,  //  5  REB
                     0.476, -0.011,  0,  //  6  R
                     1,     -0.5,    0,  //  7  RET
                     1,     -1,      0,  //  8  C
                     0.480, -1,      0,  //  9  BRC
                    -0.003, -0.276,  0,  // 10  B
                    -0.480, -1,      0,  // 11  BLC
                    -1,     -1,      0,  // 12  D
                    -1,     -0.5,    0,  // 13  LET
                    -0.494, -0.011,  0,  // 14  L
                    -1,      0.5,    0,  // 15  LEB
                ]);
                // prettier-ignore
                const idx = new Uint16Array([
                    // top-left corner: A,TLC,T,L,LEB
                     0,  1,  2,
                     0,  2, 14,
                     0, 14, 15,
                    // top-right corner: TRC,BR,REB,R,T
                     3,  4,  5,
                     3,  5,  6,
                     3,  6,  2,
                    // centre: T,R,B,L
                     2,  6, 10,
                     2, 10, 14,
                    // bottom-right corner: RET,C,BRC,B,R
                     7,  8,  9,
                     7,  9, 10,
                     7, 10,  6,
                    // bottom-left corner: LET,L,B,BLC,D
                    13, 14, 10,
                    13, 10, 11,
                    13, 11, 12,
                ]);
                gPMXFill = new T.BufferGeometry();
                gPMXFill.setAttribute('position', new T.BufferAttribute(pos, 3));
                gPMXFill.setIndex(new T.BufferAttribute(idx, 1));
            }
            pPMXFill = pool(noteG, () => new T.Mesh(
                gPMXFill,
                new T.MeshBasicMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: 1.0,
                    depthWrite: false,
                    depthTest: false,
                    fog: false,
                    side: T.DoubleSide,
                }),
            ));

            // FH (frethand mute) strum X fill — 5 regions: 4 corner quadrants + centre diamond.
            // 12 vertices, 10 triangles. L/R wings stop at fx=±0.50 (no solid lateral blocks).
            //  0=LET(-0.50,+1)  1=TLC(-0.15,+1)  2=T(0,+0.42)   3=TRC(+0.15,+1)
            //  4=RET(+0.50,+1)  5=REB(+0.50,-1)  6=R(+0.28,0)   7=B(0,-0.42)
            //  8=BRC(+0.15,-1)  9=BLC(-0.15,-1) 10=LEB(-0.50,-1) 11=L(-0.28,0)
            {
                // prettier-ignore
                const pos = new Float32Array([
                    -0.50,  1,      0,  //  0  LET
                    -0.15,  1,      0,  //  1  TLC
                     0,     0.42,   0,  //  2  T
                     0.15,  1,      0,  //  3  TRC
                     0.50,  1,      0,  //  4  RET
                     0.50, -1,      0,  //  5  REB
                     0.28,  0,      0,  //  6  R
                     0,    -0.42,   0,  //  7  B
                     0.15, -1,      0,  //  8  BRC
                    -0.15, -1,      0,  //  9  BLC
                    -0.50, -1,      0,  // 10  LEB
                    -0.28,  0,      0,  // 11  L
                ]);
                // prettier-ignore
                const idx = new Uint16Array([
                    // top-left corner: LET,TLC,T,L
                     0,  1,  2,
                     0,  2, 11,
                    // top-right corner: TRC,RET,R,T
                     3,  4,  6,
                     3,  6,  2,
                    // bottom-right corner: REB,R,B,BRC
                     5,  6,  7,
                     5,  7,  8,
                    // bottom-left corner: LEB,L,B,BLC
                    10, 11,  7,
                    10,  7,  9,
                    // centre diamond: L,T,R,B
                    11,  2,  6,
                    11,  6,  7,
                ]);
                gFHXFill = new T.BufferGeometry();
                gFHXFill.setAttribute('position', new T.BufferAttribute(pos, 3));
                gFHXFill.setIndex(new T.BufferAttribute(idx, 1));
            }
            pFHXFill = pool(noteG, () => new T.Mesh(
                gFHXFill,
                new T.MeshBasicMaterial({
                    color: 0x000000,
                    transparent: true,
                    opacity: 1.0,
                    depthWrite: false,
                    depthTest: false,
                    fog: false,
                    side: T.DoubleSide,
                }),
            ));

            pChordLbl   = pool(lblG,  () => new T.Sprite(txtMat('', '#e8d080', true, 'chord').clone()));
            // Single shared barre material — all pool meshes reference it,
            // so _applyGlow() can mutate emissiveIntensity once and every
            // recycled / future-allocated barre mesh picks up the change.
            mBarre = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 * glowMul, transparent: true, depthWrite: false });
            pBarreLine  = pool(noteG, () => new T.Mesh(new T.BoxGeometry(1, 1, 1), mBarre));

            // Per-note fret number below note with connector line
            pNoteFretLabel = pool(lblG, () => new T.Sprite(txtMat('0', FRET_LABEL_GOLD_HEX, false, 'noteFret').clone()));
            pConnectorLine = pool(noteG, () => new T.Line(
                new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 1, 0)]),
                new T.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.5 }),
            ));
            pDropLine = pool(noteG, () => new T.Line(
                new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 1, 0)]),
                new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
            ));

            // Fret-column reference markers (visual cue for X-position to fret-number).
            // Each sprite gets its own clone so the per-frame material.map swap
            // (dark vs light grey) doesn't poison neighbours sharing the same
            // cached texture map.
            pFretColMarker = pool(lblG, () => new T.Sprite(txtMat('0', '#666666', false, 'noteFret').clone()));

            _bgLoadSettings();
            buildBoard();

            // Background animations (#13). Read settings keyed by this
            // panel and mount the active style's meshes. Subscribe to
            // in-app settings changes (settings.html via window.h3dBgSet*)
            // so they propagate without a reload. Manual localStorage
            // edits don't fire the pub-sub and require a reload.
            // Push the freshly-loaded vibrancy/glow values into the
            // materials. _bgLoadSettings only triggers a palette re-apply
            // when the palette ID actually changed, so a fresh-init user
            // on the default palette would otherwise keep the hardcoded
            // construction-time material values until they touched a
            // slider.
            _applyVibrancy();
            _applyGlow();
            // inlayLabelsVisible was applied before buildBoard() via _bgLoadSettings.
            bgGroup = new T.Group();
            // Note: renderOrder on a Group is a no-op (Three.js Groups
            // are transforms, not rendered objects, so renderOrder only
            // affects the actual meshes inside). _bgMountStyle stamps
            // renderOrder = -1 on every child after build, which IS what
            // forces background to render before gameplay geometry.
            // Combined with the deeper-than-note-range placements below,
            // background never paints over notes.
            scene.add(bgGroup);
            _bgMountStyle();
            _bgListener = (changedKey) => {
                if (changedKey === 'inlayLabelsVisible') {
                    _bgLoadSettings();
                    // Flip visibility on the already-built sprites; no
                    // need to rebuild the board (cheaper, preserves the
                    // shared materials and avoids palette re-apply churn).
                    for (const lbl of _inlayLabels) lbl.visible = inlayLabelsVisible;
                    return;
                }
                if (changedKey === 'nutHeadstockVisible') {
                    _bgLoadSettings();
                    if (nutHeadstockGroup) nutHeadstockGroup.visible = nutHeadstockVisible;
                    return;
                }
                if (changedKey === 'tuningLabelsVisible') {
                    _bgLoadSettings();
                    _lastOpenStringLblSig = '';
                    if (_tuningLabelSprites.length) _disposeOpenStringPitchSprites();
                    return;
                }
                if (changedKey === 'nutColor' || changedKey === 'headstockColor') {
                    _bgLoadSettings();
                    if (fretG) buildBoard();
                    for (const lbl of _inlayLabels) lbl.visible = inlayLabelsVisible;
                    return;
                }
                if (changedKey === 'reactive' || changedKey === 'showFretOnNote' ||
                    changedKey === 'fretNumberGhostScope' ||
                    changedKey === 'cameraSmoothing' || changedKey === 'zoomSmoothing' ||
                    changedKey === 'tiltSmoothing' || changedKey === 'cameraLockLow' ||
                    changedKey === 'cameraLockZoom' || changedKey === 'cameraMode' ||
                    changedKey === 'textSize' ||
                    changedKey === 'chordDiagramSize' || changedKey === 'chordDiagramPosition' ||
                    changedKey === 'fretColumnMarkerCadence' ||
                    changedKey === 'sectionLabelsOnHighway' ||
                    changedKey === 'sectionHudVisible' ||
                    changedKey === 'sectionHudPosition' ||
                    changedKey === 'sectionHudSize' ||
                    changedKey === 'projectionVisible') {
                    // Flag flips don't need a mesh rebuild — just refresh
                    // the per-instance state for the next frame to consult.
                    // Same shape for showFretOnNote (#12), cameraSmoothing
                    // (#34), the zoom/tilt smoothing follow-ups, and
                    // cameraLockLow — all read per-frame in update() /
                    // camUpdate().
                    _bgLoadSettings();
                    return;
                }
                if (changedKey === 'vibrancy') {
                    _bgLoadSettings();
                    _applyVibrancy();
                    return;
                }
                if (changedKey === 'glow') {
                    _bgLoadSettings();
                    _applyGlow();
                    return;
                }
                if (changedKey === 'palette') {
                    // Palette change has three effects:
                    //  1. _bgLoadSettings -> _applyPaletteToMaterials
                    //     retints the per-instance shared materials
                    //     (notes, glows, sustain trails, projection).
                    //  2. buildBoard rebuilds the fretboard meshes
                    //     (LineBasicMaterial lane lines + per-string
                    //     BoxGeometry materials). These are created at
                    //     build time with palette-baked colors and
                    //     aren't reachable from _applyPaletteToMaterials.
                    //  3. lights bg style bakes palette colors into
                    //     sprite quads at build time, so it needs a
                    //     full mesh rebuild — fire _bgRebuild when
                    //     that style is active.
                    _bgLoadSettings();
                    if (fretG) buildBoard();
                    if (bgStyleId === 'lights') _bgRebuild();
                    return;
                }
                if (changedKey === 'customImageDataUrl') {
                    // Asset bytes changed. Rebuild only when the image
                    // style is active — otherwise the new bytes will
                    // pick up next time the user picks `image`.
                    _bgLoadSettings();
                    if (bgStyleId === 'image') _bgRebuild();
                    return;
                }
                if (changedKey === 'customImageName') {
                    // Display-only metadata; no mesh rebuild.
                    _bgLoadSettings();
                    return;
                }
                if (changedKey === 'customVideoName') {
                    // Filename change → new <video> source. Rebuild
                    // only when the video style is currently active;
                    // otherwise the new bytes pick up next time the
                    // user picks `video`.
                    _bgLoadSettings();
                    if (bgStyleId === 'video') _bgRebuild();
                    return;
                }
                if (changedKey === 'intensity') {
                    _bgLoadSettings();
                    // Image style reads s.intensity per frame inside
                    // update() to scale the drift speed, so a live
                    // mutation is enough — no need to tear down and
                    // re-decode the texture for every slider change.
                    // The procedural styles bake intensity into mesh
                    // count, opacity, and size at build time, so they
                    // still need a full rebuild.
                    if (bgStyleId === 'image' && bgState) {
                        bgState.intensity = bgIntensity;
                        return;
                    }
                    _bgRebuild();
                    return;
                }
                if (!changedKey || changedKey === 'style') {
                    _bgRebuild();
                }
            };
            _bgSubscribe(_bgListener);

            // Notedetect feedback (#9). Listen for hit/miss events on
            // window. Notedetect dispatches both globally and on its
            // instanceRoot; the global fire is fine for our case since
            // each 3dhighway panel just stores any event into its own
            // queue and renders only the matching note. Listeners are
            // per-panel so destroy() can cleanly remove them; cost is
            // a per-event branch + push, negligible vs per-frame work.
            // Validate every payload field we'll later compare against
            // chart-data fields (s, f, t). drawNote compares with
            // Math.abs(m.noteTime - n.t) and trusts the values are
            // finite, so reject any payload missing one of those
            // fields here rather than letting bogus data into the
            // arrays. Prune expired marks on every push so the arrays
            // settle back to empty when notedetect stops emitting —
            // drawNote's fast-path short-circuit
            // (`if (_ndHitMarks.length || _ndMissMarks.length)`) only
            // works if expired entries don't linger.
            const _ndNormalizeMark = (d) => {
                if (!d) return null;
                const note = d.note || d.chartNote;
                if (!note) return null;
                if (!Number.isFinite(note.s) || !Number.isFinite(note.f) || !Number.isFinite(d.noteTime)) return null;
                const labels = [];
                if (d.timingState && d.timingState !== 'OK' && Number.isFinite(d.timingError)) {
                    labels.push({
                        text: `${d.timingState === 'EARLY' ? '↑' : '↓'} ${d.timingError > 0 ? '+' : ''}${d.timingError}ms`,
                        color: '#ffb347',
                    });
                }
                if (d.pitchState && d.pitchState !== 'OK' && Number.isFinite(d.pitchError)) {
                    labels.push({
                        text: `${d.pitchState === 'SHARP' ? '♯' : '♭'} ${d.pitchError > 0 ? '+' : ''}${d.pitchError}¢`,
                        color: '#66c7ff',
                    });
                }
                return { s: note.s, f: note.f, noteTime: d.noteTime, labels };
            };
            const _ndPushMark = (arr, d) => {
                const mark = _ndNormalizeMark(d);
                if (!mark) return arr;
                const now = performance.now();
                // Prune expired entries unconditionally. The dedupe path
                // below can extend expiresAt of any entry (including arr[0]),
                // so an arr[0] gate is not reliable — it would prevent
                // pruning entries that expired behind a refreshed front
                // entry, allowing the array to grow unbounded. These arrays
                // are tiny (a handful of marks at most), so an unconditional
                // filter() is negligible and always correct.
                if (arr.length !== 0) {
                    const live = arr.filter(m => m.expiresAt > now);
                    arr.length = 0;
                    if (live.length) arr.push(...live);
                }
                const existing = arr.find(m =>
                    m.s === mark.s && m.f === mark.f && Math.abs(m.noteTime - mark.noteTime) < _ND_TIME_EPS
                );
                if (existing) {
                    existing.labels = mark.labels.length ? mark.labels : existing.labels;
                    existing.expiresAt = Math.max(existing.expiresAt, now + _ND_TTL_MS);
                    return arr;
                }
                arr.push({ ...mark, expiresAt: now + _ND_TTL_MS });
                return arr;
            };
            _ndOnHit = (e) => { _ndHitMarks = _ndPushMark(_ndHitMarks, e.detail); };
            _ndOnMiss = (e) => { _ndMissMarks = _ndPushMark(_ndMissMarks, e.detail); };
            window.addEventListener('notedetect:hit', _ndOnHit);
            window.addEventListener('notedetect:miss', _ndOnMiss);
            if (window.slopsmith &&
                    typeof window.slopsmith.on  === 'function' &&
                    typeof window.slopsmith.off === 'function') {
                _ndOnBusHit  = (e) => { _ndHitMarks  = _ndPushMark(_ndHitMarks,  e.detail); };
                _ndOnBusMiss = (e) => { _ndMissMarks = _ndPushMark(_ndMissMarks, e.detail); };
                window.slopsmith.on('note:hit', _ndOnBusHit);
                window.slopsmith.on('note:miss', _ndOnBusMiss);
            }

            return true;
        }

        function _bgLoadSettings() {
            const panelKey = _bgPanelKey(highwayCanvas);
            bgStyleId = _bgReadSetting(panelKey, 'style');
            bgIntensity = _bgReadSetting(panelKey, 'intensity');
            bgReactive = _bgReadSetting(panelKey, 'reactive');
            const newPaletteId = _bgReadSetting(panelKey, 'palette');
            const newPalette = PALETTES[newPaletteId] || PALETTES.default;
            if (newPalette !== activePalette) {
                activePalette = newPalette;
                _applyPaletteToMaterials();
            }
            showFretOnNote = _bgReadSetting(panelKey, 'showFretOnNote');
            fretNumberGhostScope = _bgReadSetting(panelKey, 'fretNumberGhostScope');
            cameraSmoothing = _bgReadSetting(panelKey, 'cameraSmoothing');
            // Mirror-at-first-read: zoom + tilt sliders inherit cameraSmoothing
            // when the user has never explicitly written them. Once the user
            // moves either slider, the corresponding _bgHasStored() flips
            // true and the read becomes independent.
            zoomSmoothing = _bgHasStored(panelKey, 'zoomSmoothing')
                ? _bgReadSetting(panelKey, 'zoomSmoothing')
                : cameraSmoothing;
            tiltSmoothing = _bgHasStored(panelKey, 'tiltSmoothing')
                ? _bgReadSetting(panelKey, 'tiltSmoothing')
                : cameraSmoothing;
            cameraLockLow = _bgReadSetting(panelKey, 'cameraLockLow');
            cameraLockZoom = _bgReadSetting(panelKey, 'cameraLockZoom');
            cameraMode = _bgReadSetting(panelKey, 'cameraMode');
            textSize             = _bgReadSetting(panelKey, 'textSize');
            vibrancy             = _bgReadSetting(panelKey, 'vibrancy');
            glowMul              = _bgReadSetting(panelKey, 'glow');
            chordDiagramSize     = _bgReadSetting(panelKey, 'chordDiagramSize');
            chordDiagramPosition = _bgReadSetting(panelKey, 'chordDiagramPosition');
            fretColumnMarkerCadence = _bgReadSetting(panelKey, 'fretColumnMarkerCadence');
            inlayLabelsVisible = _bgReadSetting(panelKey, 'inlayLabelsVisible');
            sectionLabelsOnHighway = _bgReadSetting(panelKey, 'sectionLabelsOnHighway');
            sectionHudVisible      = _bgReadSetting(panelKey, 'sectionHudVisible');
            sectionHudPosition     = _bgReadSetting(panelKey, 'sectionHudPosition');
            sectionHudSize         = _bgReadSetting(panelKey, 'sectionHudSize');
            nutHeadstockVisible    = _bgReadSetting(panelKey, 'nutHeadstockVisible');
            tuningLabelsVisible    = _bgReadSetting(panelKey, 'tuningLabelsVisible');
            nutColor               = _bgReadSetting(panelKey, 'nutColor');
            headstockColor         = _bgReadSetting(panelKey, 'headstockColor');
            projectionVisible      = _bgReadSetting(panelKey, 'projectionVisible');
            _vibrancyIdleOp = 0.4  + 0.6  * vibrancy;
            _vibrancyProjOp = 0.15 + 0.35 * vibrancy;
            // Custom image asset is a single GLOBAL slot — bytes are
            // shared across panels (per-panel choice is which style
            // each panel renders, not which asset). Reading via
            // _bgReadSetting would let a stray h3d_bg_panel<idx>_*
            // override silently re-introduce the per-panel asset
            // duplication this design deliberately avoids (and
            // h3dBgClearCustomImage wouldn't reach those overrides).
            // Read globals directly instead.
            //
            // Precedence: in-memory fallback BEFORE localStorage. The
            // setter always populates _bgMemFallback (even when the
            // localStorage write fails on quota), so the fallback
            // holds the most-recent staged value. Reading localStorage
            // first would mean a failed write leaves the renderer
            // pointed at the previous asset while settings.html shows
            // a "session-only" warning claiming the new bytes are in
            // effect — UI and renderer would silently disagree.
            const memDataUrl = _bgMemFallback.customImageDataUrl;
            const memName    = _bgMemFallback.customImageName;
            try {
                const gDataUrl = (memDataUrl !== undefined) ? memDataUrl : localStorage.getItem('h3d_bg_customImageDataUrl');
                const gName    = (memName    !== undefined) ? memName    : localStorage.getItem('h3d_bg_customImageName');
                bgCustomImageDataUrl = (gDataUrl != null) ? gDataUrl : BG_DEFAULTS.customImageDataUrl;
                bgCustomImageName    = (gName    != null) ? gName    : BG_DEFAULTS.customImageName;
            } catch (_) {
                bgCustomImageDataUrl = (memDataUrl !== undefined) ? memDataUrl : BG_DEFAULTS.customImageDataUrl;
                bgCustomImageName    = (memName    !== undefined) ? memName    : BG_DEFAULTS.customImageName;
            }
            // Custom video filename: also a single global slot, same
            // mem-first precedence as the image keys (a quota-failed
            // setItem leaves _bgMemFallback ahead of localStorage).
            const memVideoName = _bgMemFallback.customVideoName;
            try {
                const gVideoName = (memVideoName !== undefined) ? memVideoName : localStorage.getItem('h3d_bg_customVideoName');
                bgCustomVideoName = (gVideoName != null) ? gVideoName : BG_DEFAULTS.customVideoName;
            } catch (_) {
                bgCustomVideoName = (memVideoName !== undefined) ? memVideoName : BG_DEFAULTS.customVideoName;
            }
        }
        // Live-swap palette by mutating existing materials in place.
        // Three.js colors propagate to all sharing meshes on the next
        // render — no rebuild, no GC. The mGlow material was authored
        // with .color = white and the per-string color in .emissive
        // only; we preserve that here so the glow look stays consistent
        // before/after a palette swap rather than tinting the diffuse
        // white. Lane lines and drop lines that read
        // activePalette[s] per frame pick up automatically. Per-string
        // fretboard materials built inside buildBoard() are independent
        // and aren't reachable from here — buildBoard re-runs from the
        // palette listener to regenerate them with the new colors.
        //
        // projMeshArr holds filled rim meshes (ExtrudeGeometry frame); centre
        // is open. Palette + vibrancy mutate each mesh's material like mStr.
        function _applyPaletteToMaterials() {
            for (let s = 0; s < activePalette.length; s++) {
                const c = activePalette[s];
                if (mStr[s]) { mStr[s].color.setHex(c); mStr[s].emissive.setHex(c); }
                if (mGlow[s]) mGlow[s].emissive.setHex(c);
                if (mSus[s]) mSus[s].color.setHex(c);
                if (mStrHitOutline[s]) {
                    mStrHitOutline[s].color.setHex(c);
                    mStrHitOutline[s].emissive.setHex(c);
                }
                if (mAccentOutline[s]) {
                    mAccentOutline[s].color.setHex(c);
                    mAccentOutline[s].emissive.setHex(c);
                }
                if (mAccentCore[s]) mAccentCore[s].emissive.setHex(c);
                for (const haloArr of [mAccentHaloNear, mAccentHaloMid, mAccentHaloFar]) {
                    if (haloArr[s]) haloArr[s].color.setHex(c);
                }
                const pm = projMeshArr && projMeshArr[s];
                if (pm && pm.material) {
                    pm.material.color.setHex(c);
                    pm.material.emissive.setHex(c);
                }
            }
            // Re-apply vibrancy: mGlow's color is a lerp between white and
            // the palette colour, so a palette swap must rebuild that
            // lerp from the new endpoints. Skipped pre-init when mGlow
            // isn't allocated yet — _applyVibrancy() guards on that.
            _applyVibrancy();
        }

        // Vibrancy + glow live-update helpers. Both walk the same
        // material set _applyPaletteToMaterials walks (plus the static
        // outline / technique materials) and mutate uniform-backed
        // properties — colour, opacity, emissiveIntensity. No
        // material.needsUpdate flag is needed for these; Three.js
        // re-reads them on the next render call. mGlow.emissiveIntensity
        // and BASE_GLOW/MAX_GLOW/IDLE_OP are NOT written here — those
        // are stomped per-frame inside updateStringHighlights() and the
        // anticipation loop in update(), so they read glowMul /
        // _vibrancyIdleOp / vibrancy directly each frame instead.
        function _applyVibrancy() {
            const t = vibrancy;
            const idleOp     = 0.4  + 0.6  * t;  // mStr / IDLE_OP source
            // projIdleOp drives the projMeshArr ghost-frame opacity and is
            // read by drawNote() as `_vibrancyProjOp`, which layers a
            // per-frame factor on top.
            const projIdleOp = 0.15 + 0.35 * t;
            const susOp      = 0.35 + 0.45 * t;  // mSus
            const lineGlowOp = 0.15 + 0.35 * t;  // thin Line glow layer behind each string
            for (let s = 0; s < activePalette.length; s++) {
                if (mStr[s])  mStr[s].opacity  = idleOp;
                if (mSus[s])  mSus[s].opacity  = susOp;
                if (mGlow[s]) {
                    // Hit-note body lerps from white (current pastel
                    // look — colour comes through the emissive only)
                    // toward the palette colour as vibrancy → 1, so at
                    // vibrancy=1 the white-wash on hit notes goes away.
                    if (!_paletteColorTmp && T) _paletteColorTmp = new T.Color();
                    if (_paletteColorTmp) {
                        mGlow[s].color.setHex(0xffffff).lerp(_paletteColorTmp.setHex(activePalette[s]), t);
                    }
                }
                if (mAccentCore[s]) {
                    if (!_paletteColorTmp && T) _paletteColorTmp = new T.Color();
                    if (_paletteColorTmp) {
                        mAccentCore[s].color.setHex(0xffffff).lerp(_paletteColorTmp.setHex(activePalette[s]), t);
                    }
                }
                const pm = projMeshArr && projMeshArr[s];
                if (pm && pm.material) pm.material.opacity = projIdleOp;
            }
            // stringLines[s].material.opacity is overwritten by
            // updateStringHighlights() every frame, so the closed-form
            // value would be stomped. updateStringHighlights() reads
            // _vibrancyIdleOp directly instead — keep that in sync.
            for (let s = 0; s < stringLineGlows.length; s++) {
                const line = stringLineGlows[s];
                if (line && line.material) line.material.opacity = lineGlowOp;
            }
            _vibrancyIdleOp = idleOp;
            _vibrancyProjOp = projIdleOp;
        }
        function _applyGlow() {
            const g = glowMul;
            for (let s = 0; s < activePalette.length; s++) {
                if (mStr[s])  mStr[s].emissiveIntensity  = 0.002 * g;
                // mGlow[s].emissiveIntensity is per-frame in update();
                // see Phase 4 comment block.
                const pm = projMeshArr && projMeshArr[s];
                if (pm && pm.material) pm.material.emissiveIntensity = 0.002 * g;
                if (mStrHitOutline[s]) mStrHitOutline[s].emissiveIntensity = 1.0 * g;
                if (mAccentOutline[s]) mAccentOutline[s].emissiveIntensity = ACCENT_RIM_BASE_EMISSIVE * g;
                // mAccentCore[].emissiveIntensity is per-frame in update()
                // alongside mGlow (accent fill boost).
            }
            if (mWhiteOutline) mWhiteOutline.emissiveIntensity = 0.6 * g;
            if (mHitOutline)   mHitOutline.emissiveIntensity   = 1.0 * g;
            if (mMissOutline)  mMissOutline.emissiveIntensity  = 1.0 * g;
            if (mMissCore)     mMissCore.emissiveIntensity     = 0.4 * g;
            if (mSusOutline)   mSusOutline.emissiveIntensity   = 0.3 * g;
            if (mTapChevron)   mTapChevron.emissiveIntensity   = 0.9 * g;
            if (mBarre)        mBarre.emissiveIntensity        = 0.9 * g;
            for (let si = 0; si < activePalette.length; si++) {
                if (mAccentHaloNear[si]) mAccentHaloNear[si].opacity = ACCENT_HALO_OP_NEAR * g;
                if (mAccentHaloMid[si]) mAccentHaloMid[si].opacity = ACCENT_HALO_OP_MID * g;
                if (mAccentHaloFar[si]) mAccentHaloFar[si].opacity = ACCENT_HALO_OP_FAR * g;
            }
        }
        function _bgMountStyle() {
            const style = BG_STYLES[bgStyleId] || BG_STYLES.off;
            // Build into a fresh stage group so a partial throw can't
            // orphan meshes inside bgGroup. On success the stage joins
            // bgGroup atomically; on failure the stage and everything
            // in it are disposed and bgState stays null.
            const stage = new T.Group();
            let result = null;
            try {
                result = style.build(stage, {
                    intensity: bgIntensity,
                    palette: activePalette,
                    customImageDataUrl: bgCustomImageDataUrl,
                    customVideoName: bgCustomVideoName,
                    cam: cam,
                }) || null;
            } catch (e) {
                console.error('[3D-Hwy] bg style build failed', bgStyleId, e);
                _bgDisposeGroupTree(stage);
                bgState = null;
                bgStage = null;
                return;
            }
            // renderOrder on a Group doesn't propagate to its children
            // (Three.js sorts by per-object renderOrder, and a Group is a
            // transform, not a rendered object). Stamp every mesh in the
            // stage so transparent bg objects always sort behind notes
            // regardless of their z relative to gameplay geometry.
            stage.traverse((c) => { c.renderOrder = -1; });
            bgGroup.add(stage);
            bgStage = stage;
            bgState = result;
        }
        function _bgUnmountStyle() {
            const style = BG_STYLES[bgStyleId] || BG_STYLES.off;
            try { style.teardown(bgState); } catch (e) { console.error('[3D-Hwy] bg teardown', e); }
            bgState = null;
            // Belt + suspenders: even if a style's teardown forgets to
            // dispose something, the stage tree dispose mops up.
            if (bgStage) {
                bgStage.parent?.remove(bgStage);
                _bgDisposeGroupTree(bgStage);
                bgStage = null;
            }
        }
        // Recursively dispose geometries / materials attached to an
        // Object3D tree, then detach. Used as a safety net during
        // _bgMountStyle failures and on _bgUnmountStyle.
        //
        // Deliberately does NOT dispose material.map textures — texture
        // lifetime belongs to whoever allocated the texture. The
        // silhouettes style allocates a per-layer CanvasTexture wrapping
        // the shared _silCanvas bitmap, and disposes those textures in
        // its own teardown. Disposing them here would double-dispose,
        // and any future plugin texture sharing across panels (e.g. an
        // upcoming custom-background feature) would break the same way.
        // Style teardown owns texture release.
        function _bgDisposeGroupTree(obj) {
            if (!obj) return;
            obj.traverse((child) => {
                child.geometry?.dispose?.();
                const mat = child.material;
                if (mat) {
                    const mats = Array.isArray(mat) ? mat : [mat];
                    for (const m of mats) m?.dispose?.();
                }
            });
            obj.parent?.remove(obj);
        }
        function _bgRebuild() {
            if (!bgGroup) return;
            // Order matters: teardown must run against the (style id,
            // state) pair that built the meshes, so unmount BEFORE
            // reloading settings. Reload, then mount with the new id.
            _bgUnmountStyle();
            _bgLoadSettings();
            _bgMountStyle();
            // Reset dt accounting so the first frame after a switch
            // doesn't see a huge "since last update" window — that
            // would clamp to 0.1 and visibly snap motion / rotation.
            _bgLastT = 0;
        }

        /* ── Fretboard (static geometry) ────────────────────────────────── */
        function _h3dHexOrDefault(hexStr, defHex) {
            const d = defHex || BG_DEFAULTS.nutColor;
            const s = (typeof hexStr === 'string' && /^#[0-9a-fA-F]{6}$/.test(hexStr.trim()))
                ? hexStr.trim().toLowerCase()
                : d;
            return parseInt(s.slice(1), 16);
        }
        function buildBoard() {
            // Dispose before clearing (traverse: nut/headstock may live in a Group).
            while (fretG.children.length) {
                const child = fretG.children[0];
                child.traverse((o) => {
                    if (o instanceof T.Sprite) return;
                    o.geometry?.dispose?.();
                    const mat = o.material;
                    if (mat) {
                        const mats = Array.isArray(mat) ? mat : [mat];
                        for (const m of mats) m?.dispose?.();
                    }
                });
                fretG.remove(child);
            }
            stringLines = [];
            stringLineGlows = [];

            const board = boardSpanX();
            const bw = board.width + 4 * K;
            const bl = TS * (AHEAD + BEHIND);

            // Fretboard plane
            const pg = new T.PlaneGeometry(bw, bl);
            const pm = new T.MeshLambertMaterial({ color: 0x08080e, transparent: true, opacity: 0.6 });
            const p = new T.Mesh(pg, pm);
            p.rotation.x = -Math.PI / 2;
            p.position.set(board.center, S_BASE - NH / 2 - 2 * K, -bl / 2 + TS * BEHIND);
            fretG.add(p);

            // Thin Line strings (glow layer). Retained in stringLineGlows[]
            // so vibrancy slider changes can mutate opacity in place
            // without rebuilding the board geometry.
            // Nut lateral layout (matches headstock block below): playing strings start at the
            // fretboard-facing edge so they never project through nut/headstock.
            const mir = _leftyCached ? -1 : 1;
            const nutLenX = 1.55 * K;
            const nutXC = -0.78 * K * mir;
            const xHeadLeft = -6.85 * K * mir;
            const nutRearX = nutXC - nutLenX * 0.5;
            const nutFrontX = nutXC + nutLenX * 0.5;
            const nutJoinX = nutFrontX + 0.03 * K;
            const bridgeTipX = xFret(NFRETS) + 2 * K * mir;
            boardStringStartX = Math.min(nutJoinX, bridgeTipX);
            boardTuningLabelX = (nutRearX + xHeadLeft) * 0.5 - 0.15 * K * mir;
            const stringEndX = Math.max(nutJoinX, bridgeTipX);
            const strSpan = Math.max(stringEndX - boardStringStartX, 1.5 * K);

            const lineGlowOp = 0.15 + 0.35 * vibrancy;
            for (let s = 0; s < nStr; s++) {
                const pts = [new T.Vector3(boardStringStartX, sY(s), 0), new T.Vector3(stringEndX, sY(s), 0)];
                const g = new T.BufferGeometry().setFromPoints(pts);
                const line = new T.Line(g, new T.LineBasicMaterial({ color: activePalette[s], transparent: true, opacity: lineGlowOp }));
                fretG.add(line);
                stringLineGlows.push(line);
            }

            // BoxGeometry strings — emissive glow driven by updateStringHighlights()
            for (let s = 0; s < nStr; s++) {
                const g = new T.BoxGeometry(strSpan, STR_THICK, STR_THICK);
                // Each string gets its own material instance so emissiveIntensity is per-string
                // (and per-frame opacity is set by updateStringHighlights via _vibrancyIdleOp)
                const mat = new T.MeshStandardMaterial({
                    color: activePalette[s], emissive: activePalette[s],
                    emissiveIntensity: 0.002,
                    transparent: true, opacity: _vibrancyIdleOp, roughness: 1,
                });
                const mesh = new T.Mesh(g, mat);
                mesh.position.set(boardStringStartX + strSpan * 0.5, sY(s), 0);
                fretG.add(mesh);
                stringLines.push(mesh);
            }

            // Guitar nut + headstock — grouped so visibility + colors are user-tunable.
            {
                nutHeadstockGroup = new T.Group();
                const yTopN = Math.max(sY(0), sY(nStr - 1));
                const yBottomN = Math.min(sY(0), sY(nStr - 1));
                const yMidN = (yTopN + yBottomN) / 2;
                const spanY = Math.abs(yTopN - yBottomN) + S_GAP * 1.05;

                const nutD = 0.95 * K;
                const nutZc = -0.62 * K;
                const nutH = spanY * 1.06;
                const nutHalfH = nutH * 0.5;

                const zBack = -1.38 * K;
                const zJoint = -0.58 * K;

                const nutInt = _h3dHexOrDefault(nutColor, BG_DEFAULTS.nutColor);
                const hsInt = _h3dHexOrDefault(headstockColor, BG_DEFAULTS.headstockColor);
                const nutBase = new T.Color(nutInt);
                const nutHi = nutBase.clone().lerp(new T.Color(0xffffff), 0.14);
                const nutGro = nutBase.clone().multiplyScalar(0.72);
                const hsBase = new T.Color(hsInt);
                const hsDarkC = hsBase.clone().multiplyScalar(0.76);

                const mapleMat = new T.MeshStandardMaterial({
                    color: hsBase, roughness: 0.55, metalness: 0.02,
                });
                const mapleDark = new T.MeshStandardMaterial({
                    color: hsDarkC, roughness: 0.62, metalness: 0.02,
                });

                const coreLen = Math.max(Math.abs(nutRearX - xHeadLeft), 2 * K);
                const coreCX = (nutRearX + xHeadLeft) * 0.5;
                const headCoreD = 1.05 * K;
                const headCore = new T.Mesh(
                    new T.BoxGeometry(coreLen, spanY * 1.12, headCoreD),
                    mapleDark,
                );
                headCore.position.set(coreCX, yMidN, zBack - headCoreD * 0.35);
                nutHeadstockGroup.add(headCore);

                const xs = 14;
                const ys = 12;
                const yLo = yMidN - spanY * 0.58;
                const yHi = yMidN + spanY * 0.58;
                const posR = new Float32Array((xs + 1) * (ys + 1) * 3);
                const idxR = [];
                let ri = 0;
                for (let j = 0; j <= ys; j++) {
                    const v = j / ys;
                    const wy = yLo + v * (yHi - yLo);
                    const yArc = 1 - Math.abs((wy - yMidN) / (spanY * 0.55 + 1e-6));
                    const yArcCl = Math.max(0, Math.min(1, yArc));
                    for (let i = 0; i <= xs; i++) {
                        const u = i / xs;
                        const wx = xHeadLeft + u * (nutRearX - xHeadLeft);
                        const smooth = Math.sin(u * Math.PI * 0.5);
                        let wz = zBack + (zJoint - zBack) * smooth;
                        wz += 0.14 * K * yArcCl * yArcCl;
                        posR[ri++] = wx;
                        posR[ri++] = wy;
                        posR[ri++] = wz;
                    }
                }
                const row = xs + 1;
                for (let j = 0; j < ys; j++) {
                    for (let i = 0; i < xs; i++) {
                        const a = j * row + i;
                        const b = a + row;
                        idxR.push(a, b, a + 1, b, b + 1, a + 1);
                    }
                }
                const rampGeo = new T.BufferGeometry();
                rampGeo.setAttribute('position', new T.BufferAttribute(posR, 3));
                rampGeo.setIndex(idxR);
                rampGeo.computeVertexNormals();
                nutHeadstockGroup.add(new T.Mesh(rampGeo, mapleMat));

                const boneMat = new T.MeshStandardMaterial({
                    color: nutBase, roughness: 0.38, metalness: 0.02,
                });
                const boneTop = new T.MeshStandardMaterial({
                    color: nutHi, roughness: 0.32, metalness: 0.02,
                });
                const grooveMat = new T.MeshStandardMaterial({
                    color: nutGro, roughness: 0.85, metalness: 0,
                });

                const nutBody = new T.Mesh(
                    new T.BoxGeometry(nutLenX, nutH, nutD),
                    boneMat,
                );
                nutBody.position.set(nutXC, yMidN, nutZc);
                nutHeadstockGroup.add(nutBody);

                const crownR = nutLenX * 0.52;
                const crownSeg = new T.CylinderGeometry(
                    crownR, crownR, nutLenX * 0.92, 20, 1, true,
                    Math.PI * 0.08, Math.PI * 0.42,
                );
                const crown = new T.Mesh(crownSeg, boneTop);
                crown.rotation.z = Math.PI * 0.5;
                crown.position.set(
                    nutXC,
                    yMidN + nutHalfH - 0.02 * K,
                    nutZc + nutD * 0.22,
                );
                nutHeadstockGroup.add(crown);

                const slotDrop = 0.11 * K;
                const slotHalfW = STR_THICK * 1.15;
                const slotZ = nutZc + nutD * 0.12;
                for (let st = 0; st < nStr; st++) {
                    const gr = new T.Mesh(
                        new T.BoxGeometry(slotHalfW * 2, slotDrop, nutD * 0.42),
                        grooveMat,
                    );
                    gr.position.set(nutXC, sY(st), slotZ);
                    nutHeadstockGroup.add(gr);
                }
                nutHeadstockGroup.visible = nutHeadstockVisible;
                fretG.add(nutHeadstockGroup);
            }

            // Fret wires
            const yTop = Math.max(sY(0), sY(nStr - 1));
            const yBottom = Math.min(sY(0), sY(nStr - 1));
            for (let f = 0; f <= NFRETS; f++) {
                const x = xFret(f);
                const isMain = DOTS.includes(f);
                const g = new T.BufferGeometry().setFromPoints([
                    new T.Vector3(x, yBottom - S_GAP * 0.3, 0),
                    new T.Vector3(x, yTop + S_GAP * 0.3, 0),
                ]);
                fretG.add(new T.Line(g, new T.LineBasicMaterial({
                    color: isMain ? 0xbbbbff : 0x666688,
                    transparent: true,
                    opacity: isMain ? 0.8 : 0.4,
                })));
            }

            // Fret dots — translucent + depthWrite:false so spheres don't steal the
            // depth buffer from the transparent string meshes (which would clip the
            // strings where geometry overlaps). Slight negative Z recessed under the
            // string plane. Radius 10% below the former 1.5*K dots.
            const dotRZ = (1.5 * K * 0.9);
            const dg = new T.SphereGeometry(dotRZ, 8, 6);
            const dm = new T.MeshBasicMaterial({
                color: 0x556677,
                transparent: true,
                opacity: 1,
                depthWrite: false,
            });
            const dotZBack = -STR_THICK * 0.85;
            const my = (sY(0) + sY(nStr - 1)) / 2;
            const addDot = (x, y) => {
                const d = new T.Mesh(dg, dm);
                d.position.set(x, y, dotZBack);
                d.renderOrder = -120;
                fretG.add(d);
            };
            for (const f of DOTS) {
                const cx = xFretMid(f);
                if (DDOTS.has(f)) {
                    addDot(cx, my - S_GAP * 0.7);
                    addDot(cx, my + S_GAP * 0.7);
                } else {
                    addDot(cx, my);
                }
            }

            // Fret inlay number labels — sprites sitting just behind the hit line
            // (Z = -K) so camera-distance sorting in the transparent pass puts
            // them before notes at Z = 0, letting notes paint on top.
            // Materials are cloned from the txtMat cache with depthWrite:false so
            // the sprites don't write stale depth values that would clip incoming
            // notes (which arrive from large negative Z). Clones are tracked in
            // _inlayMats for explicit disposal on rebuild and destroy().
            // Scale uses (0.5 + textSize) directly — _textSizeMul is stale here
            // (only refreshed at the top of update()); update() rescales live.
            for (const m of _inlayMats) m.dispose();
            _inlayMats = [];
            _inlayLabels = [];
            for (const f of INLAY_LABEL_FRETS) {
                const mat = txtMat(f, '#7abfcc', false, 'fretRow').clone();
                mat.depthWrite = false;
                mat.opacity = 0.55;
                const lbl = new T.Sprite(mat);
                const scale = 5.5 * (0.5 + textSize) * fretLabelScaleForFret(f);
                lbl.scale.set(scale * K, scale * K, 1);
                lbl.position.set(xFretMid(f), yTop - S_GAP * 0.4, -K);
                lbl.visible = inlayLabelsVisible;
                fretG.add(lbl);
                _inlayLabels.push(lbl);
                _inlayMats.push(mat);
            }
        }

        /* ── String glow (called each frame) ────────────────────────────── */
        function updateStringHighlights(noteState) {
            // Glow slider scales both the idle floor and anticipation peak,
            // so glowMul=0 fully silences the per-string emissive pulse.
            // Vibrancy controls the idle opacity floor — anticipation
            // still rides on top regardless of vibrancy so play-feedback
            // through the opacity channel survives even at glowMul=0.
            const BASE_GLOW = 0.02 * glowMul;
            const MAX_GLOW  = 3.5  * glowMul;
            const IDLE_OP   = _vibrancyIdleOp;

            for (let s = 0; s < nStr; s++) {
                const mesh = stringLines[s];
                if (!mesh) continue;
                const intensity = Math.max(
                    noteState.stringSustain[s] ? 1 : 0,
                    noteState.stringAnticipation[s] || 0,
                );
                mesh.material.emissiveIntensity = BASE_GLOW + intensity * MAX_GLOW;
                mesh.material.opacity = IDLE_OP + intensity * (1 - IDLE_OP);
                mesh.scale.set(1, 1 + intensity * 0.3, 1 + intensity * 0.3);
            }
        }

        /* ── Lookahead fret bounds + smooth camera ───────────────────────── */
        function lookaheadComputeFretBounds(now, anchors, notes, chords) {
            const tEnd = now + CAM_LOOKAHEAD_SEC;
            let minF = 99;
            let maxF = 0;
            let any = false;
            if (anchors && anchors.length) {
                for (let tt = now; tt <= tEnd + 1e-9; tt += 0.125) {
                    const a = getChartAnchorAt(anchors, tt);
                    if (!a) continue;
                    let fStart = Math.round(Number(a.fret));
                    if (!Number.isFinite(fStart) || fStart < 1) fStart = 1;
                    let w = Number(a.width);
                    if (!Number.isFinite(w)) w = 4;
                    w = Math.max(1, Math.round(w));
                    const fHi = Math.min(NFRETS, fStart + w - 1);
                    minF = Math.min(minF, fStart);
                    maxF = Math.max(maxF, fHi);
                    any = true;
                }
            }
            const consider = f => {
                if (!(f > 0)) return;
                minF = Math.min(minF, f);
                maxF = Math.max(maxF, f);
                any = true;
            };
            if (notes) {
                let i = lowerBoundT(notes, now);
                for (; i < notes.length; i++) {
                    const n = notes[i];
                    if (n.t > tEnd) break;
                    if (!validString(n.s)) continue;
                    consider(n.f);
                }
            }
            if (chords) {
                let i = lowerBoundT(chords, now);
                for (; i < chords.length; i++) {
                    const ch = chords[i];
                    if (ch.t > tEnd) break;
                    if (!ch.notes) continue;
                    for (const cn of ch.notes) {
                        if (!validString(cn.s)) continue;
                        consider(cn.f);
                    }
                }
            }
            if (!any || minF > maxF) return null;
            return { minF, maxF };
        }

        function lookaheadTargetWorldX(minF, maxF) {
            const wb = CAM_FRET_EDGE_BLEND;
            const middle = (xFretMid(minF) + xFretMid(maxF)) * 0.5;
            const weighted = 0.6 * xFret(0) + 0.4 * xFret(NFRETS);
            return middle * (1 - wb) + weighted * wb;
        }

        function lookaheadSmoothCamStep(dtSec, tgtXWorld, tgtSpanInt) {
            const d = Math.min(0.2, Math.max(1e-4, dtSec));
            const fs = 1 - Math.pow(1 - CAM_FOCUS_BLEND_RATE, d);
            _lookaheadCamX = tgtXWorld * fs + _lookaheadCamX * (1 - fs);
            _lookaheadFretSpan = tgtSpanInt * fs + _lookaheadFretSpan * (1 - fs);
        }

        /* ── Camera target helper ────────────────────────────────────────── */
        // Compute and apply tgtX + tgtDist from note-window-accumulated data.
        // Used by BOTH the snap pre-pass (before drawNote() calls, skipDistHyst=true)
        // and the main per-frame camera-target block (skipDistHyst=false) so the
        // two paths can never drift out of sync.
        //
        // wX/wSum        recency-weighted fret-position centroid accumulator
        // distMin/Max    min/max fret seen in the camera targeting window
        // distGot        true iff at least one fretted note was in the window
        // camHystF       X-axis hysteresis factor (from cameraSmoothing)
        // camDistHystF   dist hysteresis factor (from zoomSmoothing)
        // skipDistHyst   true on the snap/first-data frame — no previous tgtDist
        //                state exists, so bypass the dead-zone gate
        //
        // Side-effects: updates tgtX, tgtDist, prevLowFretBonus.
        // Returns: computed lockActive flag (caller is responsible for setting
        //          prevLockActive from the returned value).
        function _applyNoteCamTargets(wX, wSum, distMin, distMax, distGot,
                                      camHystF, camDistHystF, skipDistHyst) {
            const lockActive = cameraLockLow && (!distGot || distMax <= 12);
            if (lockActive) {
                // Locked view: frets 0-12 fit in frame, with the peak
                // low-fret bonus baked in so nut chords stay framed.
                // Both halves derive from the same helpers as the
                // dynamic branch so future tuning of the base zoom
                // curve or low-fret pullback can't desync them.
                const lockedBaseU  = camBaseDistU(12);
                const lockedBonusU = camLowFretPullbackU(1);
                // cameraLockZoom slider 0..1 blends between MIN (closest)
                // and MAX (furthest). Default 0.5 maps to ~1.0× so existing
                // users see the same locked view as before this slider.
                const lockZoomMul  = CAM_LOCK_ZOOM_MIN +
                    (CAM_LOCK_ZOOM_MAX - CAM_LOCK_ZOOM_MIN) * cameraLockZoom;
                tgtX             = xFretMid(CAM_LOCK_CENTER_FRET);
                tgtDist          = (lockedBaseU + lockedBonusU) * K * lockZoomMul;
                prevLowFretBonus = lockedBonusU;
            } else if (distGot) {
                // Base zoom scales by fret count (distMax - distMin).
                const baseDistU     = camBaseDistU(distMax - distMin);
                // Low-fret pullback: world-X distance between frets is
                // logarithmic, so a 2-fret span at the nut takes much
                // more horizontal screen than the same span at fret 12.
                // The base term scales by *fret count*, not world-X
                // span, so low-fret clusters were under-allotted camera
                // distance and clipped at the left edge (e.g. F power
                // chord at fret 1 partially off-screen). Add a tapered
                // bonus that kicks in below fret 5 and peaks at fret 1
                // (≈16 extra fret-span units, i.e. 16*K world-units of
                // distance), without affecting mid/high neck framing.
                const lowFretBonusU = camLowFretPullbackU(distMin);
                if (skipDistHyst) {
                    // First data frame — no previous tgtDist state; apply
                    // directly without the hysteresis dead-zone check.
                    tgtDist = (baseDistU + lowFretBonusU) * K;
                } else {
                    // tgtDist scales at (3 * K) per fret-span unit, so the
                    // hysteresis threshold (a fret-span dead zone) converts
                    // to tgtDist-space by multiplying by 3 * K — NOT by
                    // FRET_WIDTH_MID, which is X-axis world-units-per-fret
                    // and a different unit (would over-tighten the gate by
                    // ~4x at SCALE = 2.25).
                    //
                    // Hysteresis is applied to the BASE portion only. The
                    // lowFretBonus changes by 4 fret-span units per integer
                    // fret near the nut, which sits below the default-
                    // cameraSmoothing (cs=0.5) dead zone of ~8.25 fret-span
                    // units (= 2.75 * 3) and would otherwise be suppressed
                    // for fret 2 → 1 / 3 → 1 transitions — exactly the
                    // corrections this bonus exists to provide. So gate the
                    // base, then always reflect bonus changes on top by
                    // tracking the last-committed bonus contribution
                    // (prevLowFretBonus) and adjusting tgtDist for its
                    // delta whether or not the base hysteresis fires.
                    //
                    // First frame after a lock release bypasses the gate
                    // entirely so a >12 fret note that disengaged the lock
                    // is guaranteed to widen the view. Without this, a
                    // small span jump (12→13 frets) at default settings
                    // can sit inside the dead zone and the camera fails
                    // to follow the high note that just opened the lock.
                    const candidateBase = baseDistU * K;
                    const baseTgt       = tgtDist - prevLowFretBonus * K;
                    const justUnlocked  = prevLockActive;
                    if (justUnlocked || Math.abs(candidateBase - baseTgt) > camDistHystF * 3 * K) {
                        tgtDist = (baseDistU + lowFretBonusU) * K;
                    } else if (lowFretBonusU !== prevLowFretBonus) {
                        tgtDist = baseTgt + lowFretBonusU * K;
                    }
                }
                prevLowFretBonus = lowFretBonusU;
            }
            // X-axis: recency-weighted centroid with a hysteresis dead zone
            // so small cluster shifts don't trigger visible pan motion.
            if (!lockActive && wSum > 0) {
                const candidateX = wX / wSum;
                if (Math.abs(candidateX - tgtX) > camHystF * FRET_WIDTH_MID) tgtX = candidateX;
            }
            return lockActive;
        }

        /** Tolerate RS/sloppak boolean-ish ``true`` / ``1`` forms. */
        function truthyChartFlag(v) {
            if (v === true || v === 1) return true;
            if (v === '1') return true;
            return typeof v === 'string' && v.toLowerCase() === 'true';
        }

        /** RS / sloppak `hd` (highDensity); tolerate occasional string forms. */
        function chordWireHighDensity(ch) {
            return truthyChartFlag(ch && ch.hd);
        }

        /**
         * Per spec, `displayName` is the UI label for a chord template
         * (defaulting to `name` when the chart didn't set it). Always go
         * through this helper so name vs. displayName drift can't surface
         * the wrong label or break displayName-based dedupe heuristics.
         */
        function chordTemplateLabel(tmpl) {
            if (!tmpl) return '';
            const d = tmpl.displayName;
            if (typeof d === 'string' && d.length > 0) return d;
            const n = tmpl.name;
            return typeof n === 'string' ? n : '';
        }

        /**
         * Arpeggio styling is driven by authored metadata, not by post-hoc
         * note-stream inference. Prefer explicit hand-shape flags and fall back
         * to template markers when present.
         */
        function chordTemplateMarkedArpeggio(cid, chordTemplates) {
            if (cid == null || !chordTemplates) return false;
            const tmpl = chordTemplates[cid] ?? chordTemplates[Number(cid)];
            if (!tmpl) return false;
            if (truthyChartFlag(tmpl.arp) || truthyChartFlag(tmpl.arpeggio)) return true;
            const displayName = typeof tmpl.displayName === 'string' ? tmpl.displayName.toLowerCase() : '';
            if (displayName.includes('-arp')) return true;
            const name = typeof tmpl.name === 'string' ? tmpl.name.toLowerCase() : '';
            return name.endsWith('(arp)') || name.includes(' arpeggio');
        }

        function handShapeMarkedArpeggio(hs, chordTemplates) {
            if (!hs) return false;
            if (truthyChartFlag(hs.arp) || truthyChartFlag(hs.arpeggio)) return true;
            return chordTemplateMarkedArpeggio(hsChordIdNorm(hs), chordTemplates);
        }

        /**
         * Matching hand-shape metadata for a chord onset. ``explicit`` follows
         * authored arpeggio markers only; note inference is handled separately
         * by the callers that still need it for non-visual behavior.
         */
        function chordHandShapeArpeggioHint(ch, hss, chordTemplates) {
            if (!hss || hss.length === 0) {
                return { explicit: false, covered: false, hs: null };
            }
            const t = ch.t;
            const cid = ch.id;
            for (let i = 0; i < hss.length; i++) {
                const hs = hss[i];
                const tLo = hsStart(hs);
                const tHi = hsEnd(hs);
                if (Number.isNaN(tLo) || Number.isNaN(tHi)) continue;
                if (t + 1e-4 < tLo || t > tHi + 1e-4) continue;
                const hsCid = hsChordIdNorm(hs);
                if (hsCid !== cid && Number(hsCid) !== Number(cid)) continue;
                const explicit = handShapeMarkedArpeggio(hs, chordTemplates);
                return { explicit, covered: true, hs };
            }
            return { explicit: false, covered: false, hs: null };
        }

        /** Build ``ch.notes`` from ``chordTemplates[cid].frets`` (-1 omitted). */
        function chordNotesFromTemplate(cid, templates) {
            if (templates == null || cid == null) return [];
            const tmpl = templates[cid] ?? templates[Number(cid)];
            if (!tmpl || !Array.isArray(tmpl.frets)) return [];
            const out = [];
            for (let si = 0; si < tmpl.frets.length; si++) {
                const f = tmpl.frets[si];
                if (f >= 0 && validString(si)) out.push({ s: si, f, sus: 0 });
            }
            return out;
        }

        /**
         * Rocksmith fingerpicking passages often have ``<handShape>`` + per-string
         * ``<note>`` rows but **no** ``<chord>`` events. The 3D chord frame / arp
         * styling only runs over ``bundle.chords``, so synthesize minimal chord
         * rows at each hand-shape onset when the chart omits them.
         */
        function mergeHandShapeSynthChords(realChords, handShapes, chordTemplates) {
            if (!handShapes || handShapes.length === 0) return realChords;
            const reals = realChords && realChords.length ? realChords : [];
            const synth = [];
            const seenSynth = new Set();
            const tol = 0.028;
            /**
             * Suppress a synth chord box when a real chord with the **same trimmed
             * display name** played within this window — RS CDLC commonly authors
             * several ``<chordTemplate>`` rows that share a display name (with
             * trailing-whitespace IDs) for fingering variants. The follow-up
             * hand-shape with no chord row is a fingering hint, not a new strum
             * (e.g. Jackson 5 "I Want You Back" ~0:27 — Fm7 cid=18 strum followed
             * by Fm7 cid=19 hand-shape, which earlier produced a stacked second
             * "Fm7" label and an extra chord frame).
             */
            const SAME_NAME_RUN_S = 0.5;
            const trimmedTemplateName = (cid) => {
                if (cid == null || !chordTemplates) return '';
                const tmpl = chordTemplates[cid] ?? chordTemplates[Number(cid)];
                // CDLC commonly authors several <chordTemplate> rows that share
                // a displayName for fingering variants; the suppression
                // heuristic in the surrounding code dedupes on the *label*,
                // not the underlying name, so go through chordTemplateLabel.
                return chordTemplateLabel(tmpl).trim();
            };
            outer: for (let i = 0; i < handShapes.length; i++) {
                const hs = handShapes[i];
                const cid = hs.chord_id != null ? hs.chord_id : hs.chordId;
                const st = hs.start_time != null ? hs.start_time : hs.startTime;
                if (cid == null || st == null || Number.isNaN(Number(st))) continue;
                const key = `${cid}|${Number(st).toFixed(3)}`;
                if (seenSynth.has(key)) continue;
                seenSynth.add(key);
                const myName = trimmedTemplateName(cid);
                for (let j = 0; j < reals.length; j++) {
                    const ch = reals[j];
                    const rid = ch.id;
                    const sameId = rid === cid || Number(rid) === Number(cid);
                    if (sameId && Math.abs(ch.t - st) <= tol) continue outer;
                    if (!sameId && myName !== '') {
                        const otherName = trimmedTemplateName(rid);
                        if (otherName === myName
                            && st > ch.t
                            && st - ch.t <= SAME_NAME_RUN_S) {
                            continue outer;
                        }
                    }
                }
                const notes = chordNotesFromTemplate(cid, chordTemplates);
                if (notes.length === 0) continue;
                synth.push({
                    t: st,
                    id: cid,
                    // `hd` is the Rocksmith `highDensity` wire field (gallops /
                    // repeated strums), not an arpeggio carrier — arpeggio
                    // intent is read directly from the hand-shape via
                    // chordHandShapeArpeggioHint() downstream. Keep `hd` false
                    // so chordWireHighDensity() / label-suppression behave the
                    // same as for any other non-gallop chord row.
                    hd: false,
                    notes,
                    /** Hand-shape fill-in (no authored chord row) — skip note-stream arp frame. */
                    h3dSynth: true,
                });
            }
            if (synth.length === 0) return reals;
            const merged = reals.concat(synth);
            merged.sort((a, b) => {
                const dt = a.t - b.t;
                if (Math.abs(dt) > 1e-6) return dt;
                const ia = Number(a.id);
                const ib = Number(b.id);
                return (ia - ib) || 0;
            });
            return merged;
        }

        /** Merge Rocksmith ``chordTemplates[id].frets`` with live ``chordNote`` rows. */
        function mergeChordShape(ch, chordNotes, templates) {
            const shape = new Map();
            const tid = ch && ch.id != null ? ch.id : null;
            const tmpl = (tid != null && templates)
                ? (templates[tid] ?? templates[Number(tid)])
                : null;
            if (tmpl && Array.isArray(tmpl.frets)) {
                for (let si = 0; si < tmpl.frets.length; si++) {
                    if (!validString(si)) continue;
                    const f = tmpl.frets[si];
                    if (f >= 0) shape.set(si, f);
                }
            }
            for (let i = 0; i < chordNotes.length; i++) {
                const cn = chordNotes[i];
                if (!validString(cn.s)) continue;
                if (cn.f < 0) shape.delete(cn.s);
                else shape.set(cn.s, cn.f);
            }
            return shape;
        }

        function hitTimesQualifyArpeggioSpread(hitTimes) {
            if (hitTimes.length < 2) return false;
            hitTimes.sort((a, b) => a - b);
            const spread = hitTimes[hitTimes.length - 1] - hitTimes[0];
            if (spread >= 0.03) return true;
            return hitTimes.length >= 4 && spread >= 0.016;
        }

        /** RS XML / IPC payloads use snake_case or camelCase field names. */
        function hsStart(hs) {
            if (!hs) return NaN;
            const v = hs.start_time != null ? hs.start_time : hs.startTime;
            if (v == null) return NaN;
            const n = Number(v);
            return Number.isNaN(n) ? NaN : n;
        }
        function hsEnd(hs) {
            if (!hs) return NaN;
            const v = hs.end_time != null ? hs.end_time : hs.endTime;
            if (v == null) return NaN;
            const n = Number(v);
            return Number.isNaN(n) ? NaN : n;
        }
        function hsChordIdNorm(hs) {
            if (!hs) return null;
            const v = hs.chord_id != null ? hs.chord_id : hs.chordId;
            return v == null ? null : v;
        }

        /** ``<handShape>`` chart duration in seconds (snake_case or camelCase XML). */
        function handShapeChartSpanSec(hs) {
            const a = hsStart(hs), b = hsEnd(hs);
            if (Number.isNaN(a) || Number.isNaN(b)) return 0;
            return Math.max(0, b - a);
        }

        /**
         * When ``hd`` is missing/false, detect arpeggio from the **note** stream
         * using the **full voicing** (template ∪ chord notes). RS often stores the
         * plucks only in ``notes[]``, not as duplicate chord rows.
         *
         * @param {{ tLo: number, tHi: number } | null} [timeWin]
         *        When set (e.g. from ``<handShape>`` span), scan staggered picks
         *        across the whole held-shape window — RS often omits ``arp`` and ``hd``.
         */
        function inferArpeggioFromNotePattern(ch, shape, notesArr, timeWin) {
            if (!notesArr || notesArr.length === 0 || shape.size < 2) return false;
            const tHi = timeWin ? timeWin.tHi : ch.t + 2.35;
            const tLo = timeWin ? timeWin.tLo : ch.t - 0.28;
            let i2 = lowerBoundT(notesArr, tLo - 0.02);
            const hitTimes = [];
            for (; i2 < notesArr.length; i2++) {
                const n = notesArr[i2];
                if (n.t > tHi) break;
                if (n.t < tLo) continue;
                if (!validString(n.s)) continue;
                const ef = shape.get(n.s);
                if (ef === undefined || ef !== n.f) continue;
                hitTimes.push(n.t);
            }
            if (!hitTimesQualifyArpeggioSpread(hitTimes)) return false;
            if (timeWin) {
                const winSpan = timeWin.tHi - timeWin.tLo;
                if (winSpan > ARP_INFER_MULTI_STRUM_WIN_MIN_S
                    && hitTimes.length > shape.size + ARP_INFER_MULTI_STRUM_HIT_SLACK) {
                    return false;
                }
                if (winSpan < 0.70 && hitTimes.length < 4) {
                    const spread = hitTimes[hitTimes.length - 1] - hitTimes[0];
                    if (spread < ARP_INFER_STRUM_VS_ARP_SPREAD_MIN_S) return false;
                }
                // Reject when too few staggered hits for a genuine sweep across
                // the held shape — see ARP_INFER_MIN_HITS_VS_SHAPE_CAP.
                const minHits = Math.min(shape.size, ARP_INFER_MIN_HITS_VS_SHAPE_CAP);
                if (hitTimes.length < minHits) return false;
            }
            return true;
        }

        /**
         * True when standalone note rows already cover every string/fret in the
         * arpeggio shape, so drawing the chord gems too would duplicate the same
         * authored passage.
         */
        function chordShapeCoveredByStandaloneNotes(ch, shape, notesArr, timeWin) {
            if (!notesArr || notesArr.length === 0 || !shape || shape.size === 0) return false;
            const tLo = (timeWin ? timeWin.tLo : ch.t - ARP_FRAME_ONSET_PAD_S) - NEXT_ON_STRING_T_EPS;
            const tHi = (timeWin ? timeWin.tHi : ch.t + ARP_FRAME_ONSET_CLUSTER_S) + NEXT_ON_STRING_T_EPS;
            let i2 = lowerBoundT(notesArr, tLo);
            const matchedStrings = new Set();
            for (; i2 < notesArr.length; i2++) {
                const n = notesArr[i2];
                if (n.t > tHi) break;
                if (!validString(n.s) || matchedStrings.has(n.s)) continue;
                const ef = shape.get(n.s);
                if (ef === undefined || ef !== n.f) continue;
                matchedStrings.add(n.s);
                if (matchedStrings.size >= shape.size) return true;
            }
            return false;
        }

        /**
         * Notes in an inferred arpeggio passage are charted in ``notes[]`` with
         * staggered times; treat them like chord-cluster notes for Rocksmith-style
         * board-ghost fret digits (``fromChord`` + template column).
         */
        function arpeggioChordIdForNote(n, handShapes, chordTemplates, notesArr) {
            if (!handShapes || handShapes.length === 0 || !notesArr || notesArr.length === 0) return null;
            if (!validString(n.s)) return null;
            for (let i = 0; i < handShapes.length; i++) {
                const hs = handShapes[i];
                const hsLo = hsStart(hs);
                const hsHi = hsEnd(hs);
                if (Number.isNaN(hsLo) || Number.isNaN(hsHi)) continue;
                if (n.t + 1e-4 < hsLo || n.t > hsHi + 1e-4) continue;
                const cid = hsChordIdNorm(hs);
                if (cid == null) continue;
                const tmpl = chordTemplates?.[cid] ?? chordTemplates?.[Number(cid)];
                if (!tmpl || !Array.isArray(tmpl.frets)) continue;
                const tf = tmpl.frets[n.s];
                if (typeof tf !== 'number' || tf < 0 || n.f !== tf) continue;
                const synthNotes = chordNotesFromTemplate(cid, chordTemplates);
                if (synthNotes.length === 0) continue;
                const fakeCh = { t: hsLo, id: cid, notes: synthNotes };
                const shape = mergeChordShape(fakeCh, synthNotes, chordTemplates);
                const tw = { tLo: hsLo - 0.06, tHi: hsHi + 0.06 };
                if (handShapeChartSpanSec(hs) < ARP_INFER_MIN_HAND_SHAPE_SPAN_S) continue;
                if (inferArpeggioFromNotePattern(fakeCh, shape, notesArr, tw)) return cid;
            }
            return null;
        }

        /**
         * Per-frame warmup: ``inferArpeggioFromNotePattern`` depends only on
         * ``handShape × chart``, not on the candidate note — the old path
         * recomputed it for every visible note (O(notecount × hs × notescan)).
         * Fill ``outFlags[i]`` with the boolean once per ``handShapes[i]``.
         */
        function fillArpeggioGhostInferFlags(handShapes, chordTemplates, notesArr, outFlags) {
            for (let i = 0; i < handShapes.length; i++) {
                let infer = false;
                const hs = handShapes[i];
                if (handShapeChartSpanSec(hs) < ARP_INFER_MIN_HAND_SHAPE_SPAN_S) {
                    outFlags[i] = false;
                    continue;
                }
                const cid = hsChordIdNorm(hs);
                if (cid != null && notesArr.length > 0) {
                    const tmpl = chordTemplates?.[cid] ?? chordTemplates?.[Number(cid)];
                    if (tmpl && Array.isArray(tmpl.frets)) {
                        const synthNotes = chordNotesFromTemplate(cid, chordTemplates);
                        if (synthNotes.length > 0) {
                            const hsLo = hsStart(hs);
                            const hsHi = hsEnd(hs);
                            const fakeCh = { t: hsLo, id: cid, notes: synthNotes };
                            const shape = mergeChordShape(fakeCh, synthNotes, chordTemplates);
                            const tw = { tLo: hsLo - 0.06, tHi: hsHi + 0.06 };
                            infer = inferArpeggioFromNotePattern(fakeCh, shape, notesArr, tw);
                        }
                    }
                }
                outFlags[i] = infer;
            }
        }

        function arpeggioChordIdForNoteWithInferCache(n, handShapes, chordTemplates, notesArr, hsInferFlags) {
            if (!handShapes || handShapes.length === 0 || !notesArr || notesArr.length === 0 || !hsInferFlags)
                return arpeggioChordIdForNote(n, handShapes, chordTemplates, notesArr);
            if (!validString(n.s)) return null;
            for (let i = 0; i < handShapes.length; i++) {
                if (!hsInferFlags[i]) continue;
                const hs = handShapes[i];
                const hsLo = hsStart(hs);
                const hsHi = hsEnd(hs);
                if (Number.isNaN(hsLo) || Number.isNaN(hsHi)) continue;
                if (n.t + 1e-4 < hsLo || n.t > hsHi + 1e-4) continue;
                const cid = hsChordIdNorm(hs);
                if (cid == null) continue;
                const tmpl = chordTemplates?.[cid] ?? chordTemplates?.[Number(cid)];
                if (!tmpl || !Array.isArray(tmpl.frets)) continue;
                const tf = tmpl.frets[n.s];
                if (typeof tf !== 'number' || tf < 0 || n.f !== tf) continue;
                return cid;
            }
            return null;
        }

        function handShapeIsArpeggioForLaneRail(hs, chordTemplates) {
            return handShapeMarkedArpeggio(hs, chordTemplates);
        }

        /**
         * Chart-time window for purple rails: hand-shape span clipped to matching
         * ``chords[].t`` and template notes in the passage — same times that drive
         * the 3D arpeggio frame (``ch.t`` + note stream), avoiding rails that start
         * before the box or end before the last arpeggiated note.
         */
        function effectiveArpRailChartBoundsForHandShape(hs, chords, chordTemplates, notesArr) {
            let shapeLo = hsStart(hs);
            let shapeHi = hsEnd(hs);
            const cid = hsChordIdNorm(hs);
            if (Number.isNaN(shapeLo) || Number.isNaN(shapeHi)) {
                return { shapeLo: 1e9, shapeHi: -1e9 };
            }
            if (notesArr && notesArr.length > 0 && chordTemplates && cid != null) {
                const tmpl = chordTemplates[cid] ?? chordTemplates[Number(cid)];
                if (tmpl && Array.isArray(tmpl.frets)) {
                    let tFirst = null;
                    let tLast = null;
                    for (let i = 0; i < notesArr.length; i++) {
                        const n = notesArr[i];
                        if (n.t + 1e-4 < shapeLo - 0.18 || n.t > shapeHi + 0.45) continue;
                        if (!validString(n.s)) continue;
                        const tf = tmpl.frets[n.s];
                        if (typeof tf !== 'number' || tf < 0 || n.f !== tf) continue;
                        if (tFirst === null || n.t < tFirst) tFirst = n.t;
                        if (tLast === null || n.t > tLast) tLast = n.t;
                    }
                    if (tFirst != null) shapeLo = Math.max(shapeLo, tFirst);
                    if (tLast != null) shapeHi = Math.max(shapeHi, tLast);
                }
            }
            if (chords && chords.length && cid != null) {
                let tMinC = null;
                let tMaxC = null;
                for (let j = 0; j < chords.length; j++) {
                    const ch = chords[j];
                    if (ch.id !== cid && Number(ch.id) !== Number(cid)) continue;
                    if (ch.t + 1e-4 < shapeLo || ch.t > shapeHi + 0.28) continue;
                    if (tMinC === null || ch.t < tMinC) tMinC = ch.t;
                    if (tMaxC === null || ch.t > tMaxC) tMaxC = ch.t;
                }
                if (tMinC != null) shapeLo = Math.max(shapeLo, tMinC);
                if (tMaxC != null) shapeHi = Math.max(shapeHi, tMaxC);
            }
            shapeLo -= ARP_HWY_RAIL_START_LEAD_S;
            shapeHi += ARP_HWY_RAIL_END_TAIL_S;
            return { shapeLo, shapeHi };
        }

        /** Cache the authored arpeggio marker per hand shape. */
        function fillLaneRailHandShapeFlags(handShapes, chordTemplates, outFlags) {
            const nHs = handShapes.length;
            for (let i = 0; i < nHs; i++) {
                outFlags[i] = handShapeIsArpeggioForLaneRail(handShapes[i], chordTemplates);
            }
        }

        function fillArpeggioRailShapeBoundsCaches(
            handShapes, chords, chordTemplates, notesArr, laneRailFlags, loOut, hiOut,
        ) {
            const nHs = handShapes.length;
            for (let i = 0; i < nHs; i++) {
                if (!laneRailFlags[i]) continue;
                const b = effectiveArpRailChartBoundsForHandShape(
                    handShapes[i], chords, chordTemplates, notesArr,
                );
                loOut[i] = b.shapeLo;
                hiOut[i] = b.shapeHi;
            }
        }

        /** ``[tChartLo,tChartHi]`` chart times that a lane slice covers (see module ``BEHIND`` / approach ``dt``). */
        function arpeggioLaneOuterRailChartIntervalOverlaps(
            tChartLo,
            tChartHi,
            handShapes,
            boundLo,
            boundHi,
            laneRailFlags,
        ) {
            if (!handShapes || handShapes.length === 0) return false;
            if (!laneRailFlags) return false;
            if (tChartHi < tChartLo) {
                const s = tChartLo;
                tChartLo = tChartHi;
                tChartHi = s;
            }
            for (let i = 0; i < handShapes.length; i++) {
                if (!laneRailFlags[i]) continue;
                const shapeLo = boundLo[i];
                const shapeHi = boundHi[i];
                if (tChartHi < shapeLo - 1e-4 || tChartLo > shapeHi + 1e-4) continue;
                return true;
            }
            return false;
        }

        function arpeggioLaneOuterRailLaneSlice(
            dt0, dt1, nowClock,
            handShapes, boundLo, boundHi, laneRailFlags,
        ) {
            const tLo = nowClock + Math.min(dt0, dt1) - BEHIND;
            const tHi = nowClock + Math.max(dt0, dt1) - BEHIND;
            return arpeggioLaneOuterRailChartIntervalOverlaps(
                tLo, tHi, handShapes, boundLo, boundHi, laneRailFlags,
            );
        }

        /**
         * True when **chart time** ``chartT`` falls inside an arpeggio hand-shape.
         * Uses a short end tail only — no ``CHORD_HWY_LINGER_S`` — so purple lane
         * rails match visible highway slices and do not leak after shapes end.
         */
        function arpeggioLaneOuterRailAtChartTime(
            chartT, handShapes, boundLo, boundHi, laneRailFlags,
        ) {
            return arpeggioLaneOuterRailChartIntervalOverlaps(
                chartT, chartT, handShapes, boundLo, boundHi, laneRailFlags,
            );
        }

        /**
         * Same ``chordAccent ? ft *= 1.22`` as the 3D arpeggio chord rim so lane
         * rails match an accented frame when the active hand shape links to a
         * chord row that carries ``.ac`` notes.
         */
        function arpeggioLaneDividerFrameAccentMul(nowT, handShapes, chords, boundLo, boundHi, laneRailFlags) {
            if (!handShapes || handShapes.length === 0 || !chords || chords.length === 0) return 1;
            if (!laneRailFlags) return 1;
            for (let i = 0; i < handShapes.length; i++) {
                if (!laneRailFlags[i]) continue;
                const shapeLo = boundLo[i];
                const shapeHi = boundHi[i];
                if (nowT + 1e-4 < shapeLo || nowT > shapeHi + 1e-4) continue;

                const cid = hsChordIdNorm(handShapes[i]);
                if (cid == null) return 1;
                for (let j = 0; j < chords.length; j++) {
                    const ch = chords[j];
                    if (ch.id !== cid && Number(ch.id) !== Number(cid)) continue;
                    if (Math.abs(ch.t - hsStart(handShapes[i])) > 0.12) continue;
                    const chordNotes = ch.notes ? filterValidNotes(ch.notes) : [];
                    if (chordNotes.some(cn => cn.ac)) return 1.22;
                    return 1;
                }
                return 1;
            }
            return 1;
        }

        /** World-scale XY for purple lane rails = arpeggio ``ftSide`` / ``gLaneDivider`` edge (0.15×K). */
        function arpeggioLaneDividerXYScaleMatchFrameRim(accentMul = 1) {
            const yA = sY(0), yB = sY(nStr - 1);
            const yMinF = Math.min(yA, yB) - S_GAP * 0.8;
            const yMaxF = Math.max(yA, yB) + S_GAP * 0.8;
            const fullChordBoxH = yMaxF - yMinF;
            let ft = Math.max(CHORD_FRAME_RIM_MIN * K, fullChordBoxH * CHORD_FRAME_RIM_FRAC_H);
            if (accentMul !== 1 && accentMul > 0) ft *= accentMul;
            const ftSide = ft * 1.55;
            return ftSide / (0.15 * K);
        }

        /* ── Per-frame rendering ─────────────────────────────────────────── */
        function update(bundle) {
            // Materialize the text-size multiplier from the user's slider.
            // textSize ∈ [0,1]; _textSizeMul ∈ [0.5, 1.5] with 0.5 ↦ 1.0×
            // so default behaviour matches what the renderer did pre-slider.
            _textSizeMul = 0.5 + textSize;
            // Rescale inlay labels to track the live text-size slider.
            // buildBoard() sets an initial scale using (0.5 + textSize) but
            // _textSizeMul is only authoritative from here onward.
            for (let i = 0; i < _inlayLabels.length; i++) {
                const f = INLAY_LABEL_FRETS[i];
                const s = 5.5 * _textSizeMul * K * fretLabelScaleForFret(f);
                _inlayLabels[i].scale.set(s, s, 1);
            }
            _syncOpenStringPitchLabels(bundle);

            pNote.reset(); pSus.reset(); pSusOutline.reset(); pSusRibbon.reset(); pSusRibbonOl.reset(); pTapChevron.reset(); pAccentHalo.reset(); pLbl.reset();
            pBeat.reset(); pSec.reset();
            if (projMeshArr) for (const m of projMeshArr) m.visible = false;
            pFretLbl.reset(); pLane.reset(); pLaneDivider.reset();
            if (pGhostFretLbl) pGhostFretLbl.reset();
            pChordBox.reset(); pChordFrameFill.reset(); pChordLbl.reset(); pBarreLine.reset(); pChordAccentHalo.reset(); pPMXFill.reset(); pFHXFill.reset();
            pNoteFretLabel.reset(); pConnectorLine.reset(); pDropLine.reset();
            pFretColMarker.reset(); pSusRail.reset(); pSusRailBloom.reset(); pTechPlane.reset();
            _ndLabels = [];
            let hwyLaneArpOuterDividers = false;
            _ndSizzle = [];

            // Prune expired notedetect marks once per frame instead of
            // once per drawNote call (issue #9 perf nit). drawNote then
            // only does the bounded (s, f, t) match — no per-note
            // performance.now() / filter() needed. No arr[0] gate: the
            // dedupe path can refresh any entry's expiresAt, so gating on
            // arr[0] would silently skip expired entries behind it.
            _ndFrameNowMs = performance.now();
            if (_ndHitMarks.length) {
                _ndHitMarks = _ndHitMarks.filter(m => m.expiresAt > _ndFrameNowMs);
            }
            if (_ndMissMarks.length) {
                _ndMissMarks = _ndMissMarks.filter(m => m.expiresAt > _ndFrameNowMs);
            }
            // slopsmith#254 — capture core's per-note judgment provider for
            // this frame's drawNote() calls (held-sustain glow + lit gems).
            // bundle.getNoteState is ALWAYS present (the core stub returns
            // null when no provider is registered), so its existence isn't
            // a "detect mode active" signal on its own.
            // bundle.getNoteStateProvider exposes the registered provider
            // (or null) directly — drive cull-window / chord-rim-floor
            // extensions off that so they don't activate in non-detect
            // mode. Downlevel hosts without getNoteStateProvider fall
            // back to the existence check, matching pre-PR behavior on
            // those builds.
            _ndGetNoteState = (bundle && typeof bundle.getNoteState === 'function') ? bundle.getNoteState : null;
            _ndHasProvider = (bundle && typeof bundle.getNoteStateProvider === 'function')
                ? bundle.getNoteStateProvider() != null
                : !!_ndGetNoteState;

            const now = bundle.currentTime;
            const t0 = now - BEHIND;
            const t1 = now + AHEAD;
            // With a verdict provider attached, keep notes and chord frames
            // in the outer loop past BEHIND so async verdicts (~0.4 s late)
            // still land while drawable; per-note / per-frame culling is
            // tightened back below.
            const ndVerdictT0 = _ndHasProvider
                ? now - Math.max(BEHIND, NOTEDETECT_GEM_VERDICT_WINDOW)
                : t0;
            // Prune _chordVerdicts latches whose chord has fully scrolled
            // past the loop's verdict-window cull. Forward playback never
            // re-encounters a chord, so without this prune the map would
            // grow unbounded for the rest of the song (each chord onset
            // contributes one entry, ~hundreds for a typical song).
            // verdictKey format is `${ch.id}|${ch.t}` (or `_|${ch.t}` when
            // ch.id is null), so parse the t after the last '|'.
            //
            // Backward seek (now < lastNow): every latched entry's
            // parsedT is now ahead of `now`, the forward-only check below
            // would skip them all and the map would grow on every loop.
            // Clear wholesale — the chord-loop's `chDt > 0` eviction
            // re-creates entries as chords re-enter the pre-hit window.
            //
            // Forward playback: iterate every entry. An earlier `break`
            // optimization assumed Map insertion order tracked chord
            // time, but entries are inserted when a verdict OBSERVATION
            // lands — so a later chord whose verdict arrived first could
            // sit before an earlier chord whose verdict was still
            // pending, and breaking on the first in-window entry would
            // leave the now-older later-inserted entries un-pruned. Full
            // scan is O(n) but n is bounded (chord count in the song,
            // ~hundreds) so the per-frame cost is microseconds.
            if (_ndHasProvider && _chordVerdicts.size > 0) {
                if (_chordVerdictsLastNow !== null && now < _chordVerdictsLastNow - 0.25) {
                    _chordVerdicts.clear();
                } else {
                    const pruneBefore = ndVerdictT0 - 0.5; // safety margin
                    for (const k of _chordVerdicts.keys()) {
                        const pipeIdx = k.lastIndexOf('|');
                        if (pipeIdx < 0) continue;
                        const parsedT = parseFloat(k.slice(pipeIdx + 1));
                        if (Number.isFinite(parsedT) && parsedT < pruneBefore) {
                            _chordVerdicts.delete(k);
                        }
                    }
                }
            }
            _chordVerdictsLastNow = now;

            const notes = bundle.notes;
            // Skip the merge when inputs are identity-equal to the last
            // frame's; mergeHandShapeSynthChords is chart-static.
            let chords;
            if (_mergeCacheResult !== null
                && _mergeCacheChordsRef === bundle.chords
                && _mergeCacheHsRef === bundle.handShapes
                && _mergeCacheTplRef === bundle.chordTemplates) {
                chords = _mergeCacheResult;
            } else {
                chords = mergeHandShapeSynthChords(
                    bundle.chords,
                    bundle.handShapes,
                    bundle.chordTemplates,
                );
                _mergeCacheResult = chords;
                _mergeCacheChordsRef = bundle.chords;
                _mergeCacheHsRef = bundle.handShapes;
                _mergeCacheTplRef = bundle.chordTemplates;
            }

            let arpGhostHsInfer = null;
            const hsForArpGhost = bundle.handShapes;
            if (hsForArpGhost && hsForArpGhost.length && notes && notes.length) {
                const nHs = hsForArpGhost.length;
                while (_arpGhostHsInferScratch.length < nHs) _arpGhostHsInferScratch.push(false);
                // fillArpeggioGhostInferFlags is chart-static — skip if
                // the input refs match the previous frame's.
                if (_arpGhostInferRefHs !== hsForArpGhost
                    || _arpGhostInferRefNotes !== notes
                    || _arpGhostInferRefTpl !== bundle.chordTemplates) {
                    fillArpeggioGhostInferFlags(hsForArpGhost, bundle.chordTemplates, notes, _arpGhostHsInferScratch);
                    _arpGhostInferRefHs = hsForArpGhost;
                    _arpGhostInferRefNotes = notes;
                    _arpGhostInferRefTpl = bundle.chordTemplates;
                }
                arpGhostHsInfer = _arpGhostHsInferScratch;
            }

            // ── Slide-target gem-suppression pre-pass (chart-static) ──────
            // Detects notes in bundle.notes that are the slide/link destination
            // of a preceding note. The gem (outline+core) is suppressed via
            // skipBody=true, but the sustain/slide trail still renders because
            // the trail block is now outside the !skipBody gate in drawNote().
            //
            // NOTE: an authored `linkNext` flag is NOT present in bundle.notes —
            // note_to_wire() in lib/song.py emits only t, s, f, sus, sl, slu,
            // bn, ho, po, hm, hp, pm, mt, vb, tr, ac, tp. So this is an
            // intentional timing/fret heuristic, not a link-flag lookup.
            //
            // Two source patterns (source has sus > 0):
            //   Case 1 — source has sl/slu: destination.f === source's slide target
            //   Case 2 — same fret (hold), destination has sl/slu (hold→slide)
            //
            // Sources can be single notes OR chord notes (bundle.chords).
            if (notes !== _slideTargetNotesRef || bundle.chords !== _slideTargetChordsRef) {
                _slideTargetSet = null;
                if (notes && notes.length) {
                    const stSet = new Set();
                    const checkSrc = (srcT, srcS, srcF, srcSus, srcSl) => {
                        if (!(srcSus > 0)) return;
                        const endT = srcT + srcSus;
                        // Reuse the renderer's shared next-on-string tolerance
                        // rather than a separate hardcoded literal.
                        const EPS = NEXT_ON_STRING_T_EPS;
                        let lo = 0, hi = notes.length;
                        while (lo < hi) { const m = (lo + hi) >> 1; if (notes[m].t < endT - EPS) lo = m + 1; else hi = m; }
                        for (let j = lo; j < notes.length; j++) {
                            const q = notes[j];
                            if (q.t > endT + EPS) break;
                            if (q.s !== srcS || Math.abs(q.t - endT) >= EPS) continue;
                            const qSl = (Number.isFinite(q.sl) && q.sl >= 0) ? q.sl
                                      : (Number.isFinite(q.slu) && q.slu >= 0) ? q.slu : -1;
                            if (srcSl >= 0 && q.f === srcSl) { stSet.add(`${q.t}_${q.s}`); break; } // case 1
                            if (q.f === srcF && qSl >= 0)    { stSet.add(`${q.t}_${q.s}`); break; } // case 2
                        }
                    };
                    for (let i = 0; i < notes.length; i++) {
                        const p = notes[i];
                        checkSrc(p.t, p.s, p.f, p.sus,
                            (Number.isFinite(p.sl) && p.sl >= 0) ? p.sl : (Number.isFinite(p.slu) && p.slu >= 0) ? p.slu : -1);
                    }
                    const rc = bundle.chords;
                    if (rc && rc.length) {
                        for (let ci = 0; ci < rc.length; ci++) {
                            const ch = rc[ci]; if (!ch.notes) continue;
                            for (let ni = 0; ni < ch.notes.length; ni++) {
                                const cn = ch.notes[ni];
                                checkSrc(ch.t, cn.s, cn.f, cn.sus,
                                    (Number.isFinite(cn.sl) && cn.sl >= 0) ? cn.sl : (Number.isFinite(cn.slu) && cn.slu >= 0) ? cn.slu : -1);
                            }
                        }
                    }
                    if (stSet.size > 0) _slideTargetSet = stSet;
                }
                _slideTargetNotesRef = notes;
                _slideTargetChordsRef = bundle.chords;
            }

            /** Arpeggio lane purple rails — authored-marker cache + bounds cache. */
            let laneRailArpHsFlags = null;
            let laneRailBoundLo = null;
            let laneRailBoundHi = null;
            const hsLaneRail = bundle.handShapes;
            const notesArrForRails = notes || [];
            if (hsLaneRail && hsLaneRail.length) {
                const nHsL = hsLaneRail.length;
                while (_arpLaneRailHsScratch.length < nHsL) _arpLaneRailHsScratch.push(false);
                while (_arpRailBoundLoScratch.length < nHsL) {
                    _arpRailBoundLoScratch.push(0);
                    _arpRailBoundHiScratch.push(0);
                }
                // Authored-marker flags depend only on (handShapes, templates).
                if (_laneRailFlagsRefHs !== hsLaneRail
                    || _laneRailFlagsRefTpl !== bundle.chordTemplates) {
                    fillLaneRailHandShapeFlags(hsLaneRail, bundle.chordTemplates, _arpLaneRailHsScratch);
                    _laneRailFlagsRefHs = hsLaneRail;
                    _laneRailFlagsRefTpl = bundle.chordTemplates;
                }
                // Bounds cache depends on (handShapes, chords, templates, notes).
                if (_laneRailBoundsRefHs !== hsLaneRail
                    || _laneRailBoundsRefChords !== chords
                    || _laneRailBoundsRefTpl !== bundle.chordTemplates
                    || _laneRailBoundsRefNotes !== notesArrForRails) {
                    fillArpeggioRailShapeBoundsCaches(
                        hsLaneRail,
                        chords ?? [],
                        bundle.chordTemplates,
                        notesArrForRails,
                        _arpLaneRailHsScratch,
                        _arpRailBoundLoScratch,
                        _arpRailBoundHiScratch,
                    );
                    _laneRailBoundsRefHs = hsLaneRail;
                    _laneRailBoundsRefChords = chords;
                    _laneRailBoundsRefTpl = bundle.chordTemplates;
                    _laneRailBoundsRefNotes = notesArrForRails;
                }
                laneRailArpHsFlags = _arpLaneRailHsScratch;
                laneRailBoundLo = _arpRailBoundLoScratch;
                laneRailBoundHi = _arpRailBoundHiScratch;
            }
            const beats = bundle.beats;
            const sections = bundle.sections;
            const anchors = bundle.anchors;
            const lookaheadBoundsNow = (cameraMode === 'lookahead')
                ? lookaheadComputeFretBounds(now, anchors, notes, chords)
                : null;

            // Open-string note width: same outer span as chord frame (anchor + padX,
            // or default 4-fret window when chart has no anchor at t).
            const padChordOpenX = NW * 0.4;
            const openNoteLaneBoxW = chartTime => {
                const chAncB = anchorLaneBoundsAt(anchors, chartTime);
                if (chAncB) {
                    const xl = fretX(chAncB.dMin);
                    const xr = fretX(chAncB.dMax);
                    if (xr > xl) return (xr - xl) + padChordOpenX * 2;
                }
                const spanF = 4;
                const fMinCh = 1;
                const fMaxCh = fMinCh + spanF - 1;
                const xl = fretX(fMinCh - 1);
                const xr = fretX(Math.max(fMaxCh, fMinCh + 2));
                if (xr > xl) return (xr - xl) + padChordOpenX * 2;
                return 40 * K;
            };

            // ── Frame state ───────────────────────────────────────────────
            const noteState = {
                stringSustain: new Array(nStr).fill(false),
                stringAnticipation: new Array(nStr).fill(0),
                fretHeat: new Array(NFRETS + 1).fill(0),
                strGlow: new Array(nStr).fill(0.5),
                /** Per-string extra drive for `.ac` gem fill only (`mAccentCore`). */
                accentFillBoost: new Array(nStr).fill(0),
            };

            // Compute sustain / anticipation / fret heat / per-string glow
            if (notes) {
                for (const n of notes) {
                    if (!validString(n.s)) continue;
                    const dt = n.t - now;
                    const susEnd = n.t + (n.sus || 0);
                    if (dt > 0 && dt < 0.6)
                        noteState.stringAnticipation[n.s] = Math.max(noteState.stringAnticipation[n.s], 1 - dt / 0.6);
                    if (n.f > 0) {
                        if (now >= n.t && now <= susEnd) noteState.fretHeat[n.f] = 1;
                        else if (n.t > now) noteState.fretHeat[n.f] = Math.max(noteState.fretHeat[n.f], Math.max(0, 1 - dt / 2));
                    }
                    if (now >= n.t && now <= susEnd) noteState.stringSustain[n.s] = true;
                    const sustained = dt < 0 && (n.sus || 0) > 0 && now <= susEnd;
                    const hitDist = Math.abs(dt);
                    if (hitDist < 0.15 || sustained) {
                        const hitFade = sustained ? 0.7 : (1 - hitDist / 0.15);
                        noteState.strGlow[n.s] = Math.max(noteState.strGlow[n.s], 1.0 + hitFade * 1.5);
                    }
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes) continue;
                    const chordNotes = filterValidNotes(ch.notes);
                    if (chordNotes.length === 0) continue;
                    let maxSus = 0;
                    for (const n of chordNotes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    const susEnd = ch.t + maxSus;
                    const dt = ch.t - now;
                    for (const cn of chordNotes) {
                        if (dt > 0 && dt < 0.6)
                            noteState.stringAnticipation[cn.s] = Math.max(noteState.stringAnticipation[cn.s], 1 - dt / 0.6);
                        if (cn.f > 0) {
                            if (now >= ch.t && now <= susEnd) { noteState.fretHeat[cn.f] = 1; continue; }
                            if (ch.t > now) noteState.fretHeat[cn.f] = Math.max(noteState.fretHeat[cn.f], Math.max(0, 1 - dt / 2));
                        }
                    }
                    if (now >= ch.t && now <= susEnd)
                        for (const cn of chordNotes) noteState.stringSustain[cn.s] = true;
                    const sustained = dt < 0 && maxSus > 0 && now <= susEnd;
                    const hitDist = Math.abs(dt);
                    if (hitDist < 0.15 || sustained) {
                        const hitFade = sustained ? 0.7 : (1 - hitDist / 0.15);
                        for (const cn of chordNotes) {
                            noteState.strGlow[cn.s] = Math.max(noteState.strGlow[cn.s], 1.0 + hitFade * 1.5);
                        }
                    }
                }
            }

            // ── Next-note-by-string lookahead (for anticipation projection) ──
            const nextNoteByString = new Array(nStr).fill(null);
            if (notes) {
                for (const n of notes) {
                    if (n.t <= now) continue;
                    if (!validString(n.s)) continue;
                    if (!nextNoteByString[n.s] || n.t < nextNoteByString[n.s].t) nextNoteByString[n.s] = n;
                    if (n.f > 0 && n.t > now - 0.1 && n.t < now + 2) fretLastActiveTime[n.f] = now;
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes || ch.t <= now) continue;
                    for (const cn of ch.notes) {
                        if (!validString(cn.s)) continue;
                        if (!nextNoteByString[cn.s] || ch.t < nextNoteByString[cn.s].t)
                            nextNoteByString[cn.s] = { ...cn, t: ch.t };
                        if (cn.f > 0 && ch.t > now - 0.1 && ch.t < now + 2) fretLastActiveTime[cn.f] = now;
                    }
                }
            }

            _drawNextByString = nextNoteByString;
            _drawChordTemplates = bundle.chordTemplates ?? null;

            // Ramp strGlow while the board ghost is visible so the flying note
            // core + rim read as one solid string-coloured shape with proj.
            const PROJ_WIN_MERGE = 0.6;
            if (notes) {
                for (const n of notes) {
                    if (!validString(n.s) || n.f <= 0) continue;
                    const dt = n.t - now;
                    if (dt <= 0 || dt >= PROJ_WIN_MERGE) continue;
                    const nn = nextNoteByString[n.s];
                    if (!nn || Math.abs(nn.t - n.t) > NEXT_ON_STRING_T_EPS) continue;
                    const blend = 1 - dt / PROJ_WIN_MERGE;
                    noteState.strGlow[n.s] = Math.max(noteState.strGlow[n.s], 1.0 + blend * 1.2);
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes || ch.t <= now) continue;
                    const chordNotes = filterValidNotes(ch.notes);
                    for (const cn of chordNotes) {
                        if (cn.f <= 0) continue;
                        const dt = ch.t - now;
                        if (dt <= 0 || dt >= PROJ_WIN_MERGE) continue;
                        const nn = nextNoteByString[cn.s];
                        if (!nn || Math.abs(nn.t - ch.t) > NEXT_ON_STRING_T_EPS) continue;
                        const blend = 1 - dt / PROJ_WIN_MERGE;
                        noteState.strGlow[cn.s] = Math.max(noteState.strGlow[cn.s], 1.0 + blend * 1.2);
                    }
                }
            }

            // Accent: brighter note body (`mGlow` in drawNote) instead of the old '>' sprite.
            if (notes) {
                for (const n of notes) {
                    if (!validString(n.s) || !n.ac) continue;
                    const dt = n.t - now;
                    if (dt > AHEAD) continue;
                    const susEnd = n.t + (n.sus || 0);
                    const hasSus = (n.sus || 0) > 0;
                    if (dt < -ACCENT_NOTE_LINGER_EPS && (!hasSus || now > susEnd)) continue;
                    noteState.strGlow[n.s] = Math.max(noteState.strGlow[n.s], ACCENT_NOTE_STR_GLOW);
                    noteState.accentFillBoost[n.s] = Math.max(
                        noteState.accentFillBoost[n.s],
                        ACCENT_NOTE_FILL_BOOST,
                    );
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes) continue;
                    const chordNotes = filterValidNotes(ch.notes);
                    if (!chordNotes.length) continue;
                    let maxSus = 0;
                    for (const x of chordNotes) if ((x.sus || 0) > maxSus) maxSus = x.sus;
                    const susEnd = ch.t + maxSus;
                    const dt = ch.t - now;
                    if (dt > AHEAD) continue;
                    const hasChordSus = maxSus > 0;
                    if (dt < -ACCENT_NOTE_LINGER_EPS && (!hasChordSus || now > susEnd)) continue;
                    for (const cn of chordNotes) {
                        if (!validString(cn.s) || !cn.ac) continue;
                        noteState.strGlow[cn.s] = Math.max(noteState.strGlow[cn.s], ACCENT_NOTE_STR_GLOW);
                        noteState.accentFillBoost[cn.s] = Math.max(
                            noteState.accentFillBoost[cn.s],
                            ACCENT_NOTE_FILL_BOOST,
                        );
                    }
                }
            }

            updateStringHighlights(noteState);
            // Hit-note emissive is per-frame from noteState.strGlow[s]; the
            // glow slider scales it at the assignment site since this
            // write would stomp anything _applyGlow() set statically.
            // mAccentCore adds accentFillBoost (accent-only bright fill).
            for (let s = 0; s < nStr; s++) {
                const bg = noteState.strGlow[s] * glowMul;
                if (mGlow[s]) mGlow[s].emissiveIntensity = bg;
                if (mAccentCore[s]) {
                    mAccentCore[s].emissiveIntensity =
                        bg + noteState.accentFillBoost[s] * glowMul;
                }
            }

            // Active frets (notes in cooldown window) + highway intensity
            const activeFrets = new Set();
            let highwayIntensity = 0;
            for (let f = 1; f <= NFRETS; f++) {
                if (now - fretLastActiveTime[f] < FRET_COOLDOWN) activeFrets.add(f);
            }

            // Camera targeting — steady mode (#34): recency-weighted centroid +
            // hysteresis over [camT0, camT1]. In lookahead mode, see
            // lookaheadBoundsNow + lookaheadSmoothCamStep().
            let cs = 0;
            let camAhead = CAM_TGT_AHEAD_C;
            let camTau = CAM_TGT_TAU_C;
            let camHystF = CAM_TGT_HYST_C;
            let camT0 = now - CAM_TGT_BEHIND;
            let camT1 = now + camAhead;
            let camWX = 0, camWSum = 0;
            let camDistMin = 99, camDistMax = 0, camDistGot = false;
            const camDistHystF = CAM_DIST_HYST_T + (CAM_DIST_HYST_C - CAM_DIST_HYST_T) * zoomSmoothing;
            if (!(cameraMode === 'lookahead')) {
                cs = cameraSmoothing;
                camAhead = CAM_TGT_AHEAD_T + (CAM_TGT_AHEAD_C - CAM_TGT_AHEAD_T) * cs;
                camTau = CAM_TGT_TAU_T + (CAM_TGT_TAU_C - CAM_TGT_TAU_T) * cs;
                camHystF = CAM_TGT_HYST_T + (CAM_TGT_HYST_C - CAM_TGT_HYST_T) * cs;
                camT0 = now - CAM_TGT_BEHIND;
                camT1 = now + camAhead;
            }

            // Classic path (#34): tgtDist hysteresis tracks fret span over the
            // narrowed [camT0, camT1]; lookahead mode uses lookaheadBoundsNow + span smoothing.
            //
            // Sustain extension: the outer loop keeps notes/chords
            // whose sustain still rings into the visible window —
            // n.t + (n.sus || 0) >= t0 for notes, ch.t + maxSus >= t0
            // for chords — via the continue-filters below at the top
            // of the single-note and chord branches. camT0 is narrower
            // than t0, so an onset can age past camT0 while still
            // being on screen and audible. Mirror that past-side
            // allowance here so a held low-fret chord keeps
            // contributing to both camDist (zoom) and camWX (X
            // target); otherwise the camera dollies/pans away
            // mid-sustain, re-clipping the very chord the low-fret
            // pullback was added to keep on screen. The future side
            // (camT1) is left alone so the #34 invariant (distant
            // high-fret onsets don't pre-pull the camera) still holds.

            // ── Song-change detection ─────────────────────────────────────────
            // reconnect() (used for arrangement switches and splitscreen song
            // changes) does not call renderer.destroy/init, so _camSnapped and
            // _camPreScanned would persist into the new song and the snap pre-pass
            // would never fire again.  Detect the change by comparing the current
            // song+arrangement identity against the last-seen key, and reset the
            // camera snap state (and the camera position itself) whenever it flips.
            {
                const si = bundle.songInfo;
                // bundle.songInfo has no filename field (the WS song_info message
                // never includes it).  Use window.slopsmith.currentSong.filename
                // — set by highway.js from the WS URL — combined with the
                // arrangement index as a reliable per-song-arrangement key.
                const currentSong = window.slopsmith && window.slopsmith.currentSong;
                const key = currentSong ? currentSong.filename + '\0' + (si ? (si.arrangement_index ?? '') : '') : null;
                if (key !== null && key !== _songKey) {
                    _songKey = key;
                    _camSnapped = false;
                    _camPreScanned = false;
                    tgtX = curX = xFretMid(CAM_LOCK_CENTER_FRET);
                    tgtDist = curDist = CAM_DIST_BASE;
                    prevLowFretBonus = 0;
                    prevLockActive = false;
                    _lookaheadCamX = xFretMid(CAM_LOCK_CENTER_FRET);
                    _lookaheadFretSpan = DEFAULT_LOOKAHEAD_FRET_SPAN;
                    _lookaheadCamPrevNow = null;
                    _lookaheadLowBonusU = 0;
                    _lookaheadHiNeckLatch = false;
                }
            }

            // ── Camera pre-pass (first-data snap) ────────────────────────────
            // Before any drawNote() call, iterate notes/chords to accumulate
            // the camera targeting data for THIS frame.  If this is the first
            // frame where fretted notes appear in the targeting window, snap
            // curX/curDist directly to the computed targets so open-string note
            // placement (which reads curX) and the camera are consistent on the
            // snap frame.  After the snap _camSnapped is true and this block
            // becomes a permanent no-op.  Open-string notes (f === 0) do not
            // contribute to preWX/preWSum and therefore do not trigger the snap.
            if (!_camSnapped) {
                // One-time full-chart scan (runs exactly once when both bundle.notes
                // and bundle.chords are available).  If no fretted note exists
                // anywhere in either array the snap can never fire, so we disable
                // the per-frame pre-pass immediately to avoid permanent overhead.
                // Both arrays are checked because some arrangements have fretted
                // notes only inside chords (chord-only charts, keys arrangements).
                if (!_camPreScanned && notes && chords) {
                    _camPreScanned = true;
                    const hasFrettedNote  = notes.some(n => n.f > 0 && validString(n.s));
                    const hasFrettedChord = chords.some(
                        ch => ch.notes && ch.notes.some(cn => cn.f > 0 && validString(cn.s)));
                    if (!hasFrettedNote && !hasFrettedChord) _camSnapped = true;
                }
                if (!_camSnapped) {
                    if (cameraMode === 'lookahead') {
                        const bd = lookaheadBoundsNow;
                        if (bd) {
                            _lookaheadCamX = lookaheadTargetWorldX(bd.minF, bd.maxF);
                            _lookaheadFretSpan = Math.max(1, bd.maxF - bd.minF + 1);
                            const lockSnapEl = cameraLockLow && bd.maxF <= 12;
                            if (lockSnapEl) {
                                const lockedBaseU = camBaseDistU(12);
                                const lockedBonusU = camLowFretPullbackU(1);
                                const lockZoomMul = CAM_LOCK_ZOOM_MIN +
                                    (CAM_LOCK_ZOOM_MAX - CAM_LOCK_ZOOM_MIN) * cameraLockZoom;
                                tgtX = xFretMid(CAM_LOCK_CENTER_FRET);
                                tgtDist = (lockedBaseU + lockedBonusU) * K * lockZoomMul;
                                prevLowFretBonus = lockedBonusU;
                                _lookaheadLowBonusU = lockedBonusU;
                            } else {
                                const baseDU = camBaseDistU(_lookaheadFretSpan);
                                const lowBU = camLowFretPullbackU(bd.minF);
                                tgtDist = (baseDU + lowBU) * K;
                                prevLowFretBonus = lowBU;
                                _lookaheadLowBonusU = lowBU;
                                tgtX = _lookaheadCamX;
                            }
                            curX = tgtX;
                            curDist = tgtDist;
                            _camSnapped = true;
                            _lookaheadCamPrevNow = now;
                        }
                    } else {
                    let preWX = 0, preWSum = 0, preDistMin = 99, preDistMax = 0, preDistGot = false;
                    if (notes) {
                        for (const n of notes) {
                            // bundle.notes is time-sorted: skip fully-expired sustains,
                            // break once the onset is beyond the camera window.
                            if (n.t + (n.sus || 0) < camT0) continue;
                            if (n.t > camT1) break;
                            if (!validString(n.s)) continue;
                            const nInWin  = n.f > 0 && n.t >= camT0;
                            const nSusNow = n.f > 0 && n.t < camT0 && n.t + (n.sus || 0) >= now;
                            if (nInWin || nSusNow) {
                                const w = Math.exp(-Math.abs(n.t - now) / camTau);
                                preWX += xFretMid(n.f) * w; preWSum += w;
                                if (n.f < preDistMin) preDistMin = n.f;
                                if (n.f > preDistMax) preDistMax = n.f;
                                preDistGot = true;
                            }
                        }
                    }
                    if (chords) {
                        for (const ch of chords) {
                            if (!ch.notes) continue;
                            // bundle.chords is time-sorted: break once onset is beyond window.
                            if (ch.t > camT1) break;
                            const chNotes = filterValidNotes(ch.notes);
                            if (!chNotes.length) continue;
                            let maxSus = 0;
                            for (const n of chNotes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                            if (ch.t + maxSus < camT0) continue; // fully expired
                            const chOnsetInWin = ch.t >= camT0;
                            const chSusNow     = ch.t < camT0 && ch.t + maxSus >= now;
                            if (!chOnsetInWin && !chSusNow) continue;
                            const chW = Math.exp(-Math.abs(ch.t - now) / camTau);
                            for (const cn of chNotes) {
                                const cnOk = chOnsetInWin || (chSusNow && ch.t + (cn.sus || 0) >= now);
                                if (cn.f > 0 && cnOk) {
                                    preWX += xFretMid(cn.f) * chW; preWSum += chW;
                                    if (cn.f < preDistMin) preDistMin = cn.f;
                                    if (cn.f > preDistMax) preDistMax = cn.f;
                                    preDistGot = true;
                                }
                            }
                        }
                    }
                    if (preWSum > 0) {
                        _applyNoteCamTargets(preWX, preWSum, preDistMin, preDistMax, preDistGot,
                                             camHystF, camDistHystF, /* skipDistHyst= */ true);
                        curX    = tgtX;
                        curDist = tgtDist;
                        _camSnapped = true;
                    }
                    } // end steady-mode pre-pass branch
                } // end !_camSnapped (post-prescan guard)
            }

            // ── Single notes ──────────────────────────────────────────────
            const lastFretForString = new Array(nStr).fill(undefined);
            if (notes) {
                for (const n of notes) {
                    if (n.f > 0 && n.t > now && n.t < now + 2) activeFrets.add(n.f);
                    if (n.t > now) {
                        const dt = n.t - now;
                        if (dt < AHEAD) highwayIntensity = Math.max(highwayIntensity, 1 - dt / AHEAD);
                    }
                    if (n.t + (n.sus || 0) < ndVerdictT0 || n.t > t1) continue;
                    if (!validString(n.s)) continue;
                    // Suppress the gem for linkNext slide-target notes (skipBody=true).
                    // The sustain/slide trail still renders because it now lives outside
                    // the !skipBody gate in drawNote().
                    const _isSlideTgt = !!(_slideTargetSet && _slideTargetSet.has(`${n.t}_${n.s}`));
                    const skipLabel = lastFretForString[n.s] === n.f;
                    let singleOpenX;
                    if (n.f === 0) {
                        const ab = anchorLaneBoundsAt(anchors, n.t);
                        if (ab) singleOpenX = (xFret(ab.dMin) + xFret(ab.dMax)) / 2;
                    }
                    const singleOpenLaneW = n.f === 0 ? openNoteLaneBoxW(n.t) : undefined;
                    const arGhostCid = arpeggioChordIdForNoteWithInferCache(
                        n,
                        bundle.handShapes,
                        bundle.chordTemplates,
                        notes,
                        arpGhostHsInfer,
                    );
                    drawNote(
                        n,
                        now,
                        singleOpenX,
                        skipLabel,
                        _isSlideTgt,
                        GHOST_HOLD_AFTER_ONSET,
                        singleOpenLaneW,
                        arGhostCid != null,
                        arGhostCid,
                        arGhostCid != null,
                    );
                    lastFretForString[n.s] = n.f;
                    // Onset in window OR started before the window but
                    // still sustaining right now. Gate sustain carry-over
                    // against the current frame time so camera framing
                    // releases as soon as the sustain is no longer
                    // rendered on screen.
                    if (!(cameraMode === 'lookahead')) {
                    const nInWin = n.t >= camT0 && n.t <= camT1;
                    const nSusActive = n.t < camT0 && n.t + (n.sus || 0) >= now;
                    if (n.f > 0 && (nInWin || nSusActive)) {
                        // Symmetric decay around now: previously this
                        // clamped n.t - now at 0, giving every past-
                        // onset note weight 1. That was a tolerable
                        // approximation when the past window was 0.2 s
                        // (camT0), but the sustain extension widens
                        // the past side to seconds for held notes — a
                        // 2-second-old ringing sustain would otherwise
                        // pin camWX as strongly as a fresh note and
                        // stale-out the framing for the current
                        // phrase. Math.abs lets old sustains decay on
                        // the same time-constant as future notes,
                        // matching each mode's intent: twitchy
                        // (camTau=0.35 s) drops a 0.2 s-old note's
                        // weight to ~0.56 (consistent with "react to
                        // recent only"), calm (camTau=0.9 s) to ~0.80
                        // (consistent with "average a wider window").
                        // Weight is still 1 at onset.
                        const w = Math.exp(-Math.abs(n.t - now) / camTau);
                        camWX   += xFretMid(n.f) * w;
                        camWSum += w;
                        if (n.f < camDistMin) camDistMin = n.f;
                        if (n.f > camDistMax) camDistMax = n.f;
                        camDistGot = true;
                    }
                    }
                }
            }

            // ── Chords ────────────────────────────────────────────────────
            if (chords) {
                // Single-pass shape-run tracking: the previous pre-loop scanned
                // every chord (and re-allocated chordShapeSignature() per chord)
                // each frame, even though the render loop already iterates the
                // full array. We compute runSig inline once per chord and reuse
                // it for both first-in-run detection and isRepeat below.
                // SHAPE_RUN_GAP_S also resets the run when the time gap from
                // the previous chord exceeds the same 0.5 s window used for
                // isRepeat — a chord shape that re-appears after a real
                // musical gap should re-show its label, not be treated as a
                // continuing run from many bars ago.
                const SHAPE_RUN_GAP_S = 0.5;
                let runSigPrev = null;
                let prevAnyChordTime = -Infinity;
                let prevChordSig = null;
                let prevChordTime = -1;

                for (let ci = 0; ci < chords.length; ci++) {
                    const ch = chords[ci];
                    const runSig = chordShapeSignature(ch);
                    let firstInShapeRun;
                    if (runSig === null) {
                        firstInShapeRun = true;
                    } else {
                        const gap = ch.t - prevAnyChordTime;
                        firstInShapeRun = (runSig !== runSigPrev) || gap > SHAPE_RUN_GAP_S;
                        runSigPrev = runSig;
                        // Only valid chords update the run-gap clock — an entry
                        // whose runSig is null (no notes / unusable chordId)
                        // shouldn't make the next real chord look like a tiny
                        // gap and silently fall into a "still in the run" state.
                        prevAnyChordTime = ch.t;
                    }
                    if (!ch.notes) continue;
                    // Filter chord notes to in-range strings once. All
                    // chord-level aggregations (maxSus, repeat-chord
                    // signature, open-string centroid, frame-box bounds,
                    // active-fret highlights, camera-window dist) read
                    // from chordNotes so a clamped 9th-string note can't,
                    // for instance, extend the chord's linger beyond its
                    // visible sustain.
                    const chordNotes = filterValidNotes(ch.notes);
                    if (chordNotes.length === 0) continue;
                    const chShape = mergeChordShape(ch, chordNotes, bundle.chordTemplates);

                    if (ch.t > now) {
                        const dt = ch.t - now;
                        if (dt < AHEAD) highwayIntensity = Math.max(highwayIntensity, 1 - dt / AHEAD);
                    }
                    if (ch.t > now && ch.t < now + 2)
                        for (const cn of chordNotes) { if (cn.f > 0) activeFrets.add(cn.f); }

                    let maxSus = 0;
                    for (const n of chordNotes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    if (ch.t + maxSus < ndVerdictT0 || ch.t > t1) continue;

                    // Repeat-chord detection (consecutive same shape, short gap).
                    // Reuses runSig computed at loop entry — same signature as the
                    // dedicated chordShapeSignature() call we used to make twice.
                    const isRepeat = runSig !== null && prevChordSig === runSig && Math.abs(ch.t - prevChordTime) < 0.5;
                    prevChordSig = runSig;
                    prevChordTime = ch.t;

                    // For upcoming chords use the anchor at ch.t so the frame
                    // previews the correct neck region. For lingering past chords
                    // (chDt <= 0) use the anchor at `now` so the frame stays
                    // aligned with the current lane as the song transitions between
                    // anchor regions — otherwise a post-hit linger frame keeps its
                    // old X while the lane has already moved to a new position.
                    const chDtEarly = ch.t - now;
                    const chAncB = anchorLaneBoundsAt(anchors, chDtEarly > 0 ? ch.t : now);
                    // Open-string X: chart <anchor> lane centre when present (not curX /
                    // fretted centroid), matching highway span.
                    let chordCX = curX;
                    if (chAncB) chordCX = (xFret(chAncB.dMin) + xFret(chAncB.dMax)) / 2;
                    else {
                        let cxL = Infinity, cxR = -Infinity, fretted = 0;
                        for (const cn of chordNotes) {
                            if (cn.f > 0) {
                                const fx = xFretMid(cn.f);
                                if (fx < cxL) cxL = fx;
                                if (fx > cxR) cxR = fx;
                                fretted++;
                            }
                        }
                        if (fretted > 0) chordCX = (cxL + cxR) / 2;
                    }

                    // Horizontals for chord frame + open-string mesh width. With anchors,
                    // span matches HWY lane columns (wire dMin..dMax); no extra pad.
                    let chordFrameXL = null, chordFrameXR = null, chordOpenBoxW = null;
                    let chordFrameAnchorMatched = false;
                    if (chShape.size > 1) {
                        let fMinCh = 99, fMaxCh = 0, anyFretted = false;
                        for (const [, f] of chShape) {
                            if (f > 0) {
                                anyFretted = true;
                                fMinCh = Math.min(fMinCh, f);
                                fMaxCh = Math.max(fMaxCh, f);
                            }
                        }
                        // Always prefer the anchor span so chord frames and
                        // arpeggio frames align with the highway lane window.
                        // Fretted-note span is only used when no anchor is
                        // available (e.g. sloppak without anchor data).
                        if (chAncB) {
                            chordFrameXL = xFret(chAncB.dMin);
                            chordFrameXR = xFret(chAncB.dMax);
                            chordFrameAnchorMatched = true;
                        } else if (anyFretted) {
                            chordFrameXL = xFret(fMinCh - 1);
                            chordFrameXR = xFret(Math.max(fMaxCh, fMinCh + 2));
                        } else {
                            const wNut = openNoteLaneBoxW(ch.t);
                            chordFrameXL = chordCX - wNut * 0.5;
                            chordFrameXR = chordCX + wNut * 0.5;
                        }
                        if (chordFrameXL != null && chordFrameXR != null) {
                            const span = Math.abs(chordFrameXR - chordFrameXL);
                            if (span > 1e-8) {
                                // Anchor-driven lane stripes span [dMin..dMax] wire-to-wire with
                                // no horizontal pad — match that ONLY when the frame is actually
                                // following the anchor (all-open chord, fallback path). The
                                // fretted-span path always pads so the frame breathes around
                                // the outermost fretted notes; without the pad it sat exactly
                                // on the fret lines and looked clipped.
                                if (chordFrameAnchorMatched) chordOpenBoxW = span;
                                else {
                                    const padX = NW * 0.4;
                                    chordOpenBoxW = span + padX * 2;
                                }
                            }
                        }
                    }

                    const laneWForOpenStrings = (chordOpenBoxW != null && chordOpenBoxW > 1e-8)
                        ? chordOpenBoxW
                        : openNoteLaneBoxW(ch.t);

                    const hsHintFrame = chordHandShapeArpeggioHint(ch, bundle.handShapes, bundle.chordTemplates);
                    const hsTimeWinFrame = hsHintFrame.hs
                        ? { tLo: hsStart(hsHintFrame.hs) - 0.06, tHi: hsEnd(hsHintFrame.hs) + 0.06 }
                        : null;
                    // Lazy: the coverage scan walks the note stream and is only
                    // consumed by the h3dSynth and explicit+covered branches of
                    // `deferChordGems`; computing it eagerly for every chord
                    // every frame regresses dense charts.
                    let _arpCoverMemo;
                    const noteStreamCoversArpShape = () => {
                        if (_arpCoverMemo === undefined) {
                            _arpCoverMemo = chordShapeCoveredByStandaloneNotes(
                                ch,
                                chShape,
                                notes,
                                { tLo: ch.t - ARP_FRAME_ONSET_PAD_S, tHi: ch.t + ARP_FRAME_ONSET_CLUSTER_S },
                            );
                        }
                        return _arpCoverMemo;
                    };
                    const inferredArpPattern = (!hsHintFrame.hs
                        || handShapeChartSpanSec(hsHintFrame.hs) >= ARP_INFER_MIN_HAND_SHAPE_SPAN_S)
                        && inferArpeggioFromNotePattern(
                            ch, chShape, notes, hsTimeWinFrame);
                    // Only suppress the chord gems when standalone notes really
                    // cover the arpeggio shape; otherwise explicit/synth hand
                    // shapes can produce an empty lavender frame with no notes
                    // inside (e.g. template-marked `-arp` chord rows).
                    const deferChordGems = (ch.h3dSynth && noteStreamCoversArpShape())
                        || inferredArpPattern
                        || (hsHintFrame.explicit && hsHintFrame.covered && noteStreamCoversArpShape());
                    /**
                     * Lavender chord frame + purple highway rails: authored
                     * arpeggio metadata only. RS ``highDensity`` marks gallops /
                     * repeated strums on the same voicing (e.g. Frantic ~2:46) —
                     * not arpeggio; keep ``hd`` for sustain-ribbon width via
                     * ``chordSusTrailMatchArpFrame``.
                     */
                    const chordHighwayLavenderArpVisual = hsHintFrame.explicit;
                    const chordSusTrailMatchArpFrame = chordWireHighDensity(ch)
                        || chordHighwayLavenderArpVisual;

                    // Onset in window OR chord started before the window
                    // but is still sustaining right now. Gate sustain
                    // carry-over against the current frame time so camera
                    // framing releases as soon as the chord is no longer
                    // rendered on screen.
                    const chOnsetInWin = ch.t >= camT0 && ch.t <= camT1;
                    const chSusActive  = ch.t < camT0 && ch.t + maxSus >= now;
                    const chWindowed   = chOnsetInWin || chSusActive;
                    // Symmetric decay — see matching comment in the
                    // single-note branch. The chord-wide chW uses
                    // ch.t (not per-note onset) since chord notes
                    // share a strum time.
                    const chW          = chWindowed ? Math.exp(-Math.abs(ch.t - now) / camTau) : 0;
                    // Next-chord tail: same voicing (``highDensity`` gallop) keeps full linger + optional
                    // fade suppression inside [hold−fade, hold]; a voicing change clips the tail to the
                    // chart gap so D5→D#5 (~185 ms) does not stack two cyan frames (Frantic ~2:47).
                    let cjNext = null;
                    for (let j = ci + 1; j < chords.length; j++) {
                        const cj = chords[j];
                        if (!cj?.notes) continue;
                        if (filterValidNotes(cj.notes).length === 0) continue;
                        cjNext = cj;
                        break;
                    }
                    let chordTailHoldS = CHORD_HWY_LINGER_S;
                    let chordNextSoon = false;
                    if (cjNext && cjNext.t > ch.t + 1e-6) {
                        const nextSig = chordShapeSignature(cjNext);
                        const sameVoicingNext = runSig !== null && nextSig !== null && nextSig === runSig;
                        if (sameVoicingNext) {
                            const chordFadeWinLo = ch.t + (CHORD_HWY_LINGER_S - CHORD_HWY_FADE_S);
                            const chordFadeWinHi = ch.t + CHORD_HWY_LINGER_S;
                            if (cjNext.t >= chordFadeWinLo - 1e-6 && cjNext.t <= chordFadeWinHi + 1e-6) {
                                chordNextSoon = true;
                            }
                        } else {
                            chordTailHoldS = Math.min(CHORD_HWY_LINGER_S, Math.max(cjNext.t - ch.t, 1e-3));
                        }
                    }
                    // slopsmith#254 — engine verdicts land ~0.4 s after the
                    // chord crosses; on a fast different-voicing sequence
                    // the clip above can shrink the rim's draw life below
                    // that, so the green/red latch is set but the rim isn't
                    // drawn anymore. When a verdict provider is attached,
                    // floor the hold at NOTEDETECT_GEM_VERDICT_WINDOW so
                    // the tinted rim is actually visible.
                    //
                    // This deliberately overrides the "voicing-change clip
                    // prevents two stacked cyan frames" behavior documented
                    // above (the D5→D#5 / Frantic ~2:47 case): the post-hit
                    // z clamp (Math.min(0, dZ(chDt)) below) pins extended
                    // frames at z=0, so the two frames do overlap in plane
                    // — they're distinguished by their now-tinted rim
                    // colors (green/red verdict vs teal default) rather
                    // than perspective depth. In detect mode that's the
                    // right trade: verdict visibility beats the cleaner
                    // approach silhouette. Without detect mode the
                    // original clip still applies.
                    if (_ndHasProvider && chordTailHoldS < NOTEDETECT_GEM_VERDICT_WINDOW) {
                        chordTailHoldS = NOTEDETECT_GEM_VERDICT_WINDOW;
                    }
                    const chordTailFadeS = Math.min(CHORD_HWY_FADE_S, chordTailHoldS);
                    if (!deferChordGems) {
                        for (const cn of chordNotes) {
                            const skipLabel = !firstInShapeRun || lastFretForString[cn.s] === cn.f;
                            drawNote(
                                { ...cn, t: ch.t, sus: cn.sus || 0 },
                                now,
                                cn.f === 0 ? chordCX : undefined,
                                skipLabel,
                                isRepeat,
                                chordTailHoldS,
                                cn.f === 0 ? laneWForOpenStrings : undefined,
                                true,
                                ch.id,
                                chordSusTrailMatchArpFrame,
                            );
                            lastFretForString[cn.s] = cn.f;
                            // gate by THIS note's own sustain against the
                            // current render time — drawNote has already
                            // dropped short-sustain notes whose ringing has
                            // ended, so they should not keep pulling the
                            // camera frame wider than the notes actually
                            // still on screen (chord-wide maxSus would
                            // over-pullback for mixed-sustain chords).
                            if (!(cameraMode === 'lookahead')) {
                            const cnSustainOk = chOnsetInWin || (chSusActive && ch.t + (cn.sus || 0) >= now);
                            if (cn.f > 0 && cnSustainOk) {
                                camWX += xFretMid(cn.f) * chW;
                                camWSum += chW;
                                if (cn.f < camDistMin) camDistMin = cn.f;
                                if (cn.f > camDistMax) camDistMax = cn.f;
                                camDistGot = true;
                            }
                            }
                        }
                    }

                    // Chord frame-box: rim bars + interior fill gradient.
                    const chDt = chDtEarly; // already computed above for anchor selection
                    const chordTailMul = hwyPostHitTailFadeMul(chDt, chordTailHoldS, chordNextSoon, chordTailFadeS);
                    if (chShape.size > 1 && chDt > -chordTailHoldS && chDt < AHEAD && chordOpenBoxW != null
                    ) {
                        const z = Math.min(0, dZ(chDt));
                        const width = chordOpenBoxW;
                        const xLeft = chordFrameXL;
                        const xRight = chordFrameXR;
                        const cx = (xLeft + xRight) * 0.5;
                        const yA = sY(0), yB = sY(nStr - 1);
                        const yMinF = Math.min(yA, yB) - S_GAP * 0.8;
                        const yMaxF = Math.max(yA, yB) + S_GAP * 0.8;
                        const fullChordBoxH = yMaxF - yMinF;
                        let height = fullChordBoxH;
                        if (isRepeat) height *= 0.5;
                        // Repeat frames use half height but anchor at yMinF (board
                        // level) rather than centering in the string range. With the
                        // camera tilted downward, a centered half-height frame puts
                        // its bottom bar mid-strings — far above the board — causing
                        // perspective-induced apparent X-misalignment with the lane
                        // tiles (which sit at board level). Anchoring at yMinF keeps
                        // the bottom bar near the board so both frame and lane tile
                        // edges share the same projected screen X.
                        const yBot = yMinF;
                        const yTop = yMinF + height;
                        const cY = (yBot + yTop) * 0.5;
                        const fade = Math.max(0, 1 - chDt / AHEAD);
                        const chordAccent = chordNotes.some(cn => cn.ac);

                        // Rim thickness from full vertical span — repeat halves inner height only,
                        // not bar thickness vs first chord — see CHORD_FRAME_RIM_* tuning.
                        let ft = Math.max(CHORD_FRAME_RIM_MIN * K, fullChordBoxH * CHORD_FRAME_RIM_FRAC_H);
                        if (chordAccent) ft *= 1.22;
                        // Lavender frame: authored arpeggio marker only.
                        // RS ``highDensity`` is kept out — it tags gallops & repeated
                        // strums (Frantic ~2:46), not arpeggio.
                        const isArpeggioFrame = chordHighwayLavenderArpVisual;
                        const ftSide = isArpeggioFrame ? ft * 1.55 : ft;
                        let rimHex = isArpeggioFrame ? ARPEGGIO_RIM_BLUE_HEX : CHORD_BOX_TEAL_HEX;
                        // slopsmith#254 — once the chord crosses the hit
                        // line, tint the teal frame by the note-state
                        // provider verdict: green on a clean grab, red on a
                        // miss. The verdict is async (the engine verifier
                        // reports ~0.4 s after the line), so the frame stays
                        // teal while the verdict is still pending — it must
                        // not flash red before the verdict lands. The green/
                        // red verdict is latched in _chordVerdicts so it
                        // can't flicker as constituent glows decay.
                        // Only engages when a scorer is attached. Arpeggio
                        // frames keep their blue identity.
                        // Per-occurrence key — ch.id is the template id
                        // (reused across same-shape chord occurrences) so
                        // composing it with ch.t gives one entry per
                        // physical onset in the chart.
                        const verdictKey = ch.id != null ? `${ch.id}|${ch.t}` : `_|${ch.t}`;
                        // Evict any stale latch the next time the chord
                        // re-enters the pre-hit window (rewinds, section
                        // loops, full restarts). Bounds Map growth too.
                        if (chDt > 0 && _chordVerdicts.has(verdictKey)) {
                            _chordVerdicts.delete(verdictKey);
                        }
                        // The verdict scan no longer skips authored-handshape
                        // frames — power chords sometimes carry an explicit
                        // handshape (RS authoring quirk), which previously
                        // dropped them into the `isArpeggioFrame` path and
                        // left them lavender-blue regardless of hit/miss.
                        // A true arpeggio (handshape over a real sweeping
                        // note run) is unaffected: its constituents are
                        // standalone notes judged at their own times, so the
                        // scan's query at `ch.t` finds nothing for them and
                        // the frame keeps its lavender default.
                        if (chDt <= 0 && _ndHasProvider) {
                            const latched = _chordVerdicts.get(verdictKey);
                            if (latched === 'green') {
                                rimHex = CHORD_BOX_HIT_HEX;
                            } else if (latched === 'red') {
                                rimHex = CHORD_BOX_MISS_HEX;
                            } else if (latched === 'unmatched') {
                                // The first scan past the verdict window
                                // came up empty (no constituent ever had a
                                // state — most often a true arpeggio frame
                                // whose actual notes are judged at their
                                // own times, not at ch.t). Skip the
                                // per-frame provider scan and keep the
                                // frame's default identity (lavender for
                                // arpeggios, teal for chords). See the
                                // unmatched-latch below.
                            } else {
                                // Latch both green AND red:
                                //   - any constituent 'miss' → red latched.
                                //     One decisive miss verdict means the
                                //     chord can't be all-hit; without
                                //     latching, the rim would fall back to
                                //     teal once noteStateFor's miss-wash
                                //     window (~0.6 s TTL) expires and the
                                //     state returns null again.
                                //   - all hit/active → green latched.
                                //   - else (no miss yet, some constituents
                                //     still null) → keep teal default. A
                                //     partial state must not flash red on
                                //     a chord whose verdicts arrive
                                //     incrementally.
                                let allHit = chordNotes.length > 0;
                                let anyMiss = false;
                                let anyState = false;  // true if any constituent had a non-null state this scan
                                for (const cn of chordNotes) {
                                    let cs = null;
                                    try { cs = _ndGetNoteState(cn, ch.t); } catch (e) { cs = null; }
                                    const st = (cs && typeof cs === 'object') ? cs.state : cs;
                                    if (st === 'hit' || st === 'active') {
                                        anyState = true;
                                    } else if (st === 'miss') {
                                        // First miss decides the chord — no
                                        // point querying the rest of the
                                        // constituents this frame; the rim
                                        // is about to be red-latched below.
                                        // Short-circuits provider calls in
                                        // chord-dense passages.
                                        allHit = false;
                                        anyMiss = true;
                                        anyState = true;
                                        break;
                                    } else {
                                        // null — undecided yet
                                        allHit = false;
                                    }
                                }
                                if (anyMiss) {
                                    _chordVerdicts.set(verdictKey, 'red');
                                    rimHex = CHORD_BOX_MISS_HEX;
                                } else if (allHit) {
                                    _chordVerdicts.set(verdictKey, 'green');
                                    rimHex = CHORD_BOX_HIT_HEX;
                                } else if (chDt < -_ND_UNMATCHED_LATCH_AFTER && !anyState) {
                                    // The engine verdict typically lands
                                    // ~0.4 s after the chord crosses the
                                    // line, so after the
                                    // _ND_UNMATCHED_LATCH_AFTER threshold
                                    // we've already waited well past the
                                    // verdict-arrival window. If no
                                    // constituent ever returned a non-
                                    // null state by then, there's no
                                    // verdict coming for this chord
                                    // (true arpeggio frames: their actual
                                    // notes are judged at their own
                                    // times, never at ch.t — the scan
                                    // at ch.t finds nothing forever).
                                    //
                                    // Latch 'unmatched' so subsequent
                                    // frames skip the provider scan
                                    // entirely. The threshold must be
                                    // INSIDE the chord frame's visible
                                    // draw window — `chordTailHoldS` is
                                    // floored to NOTEDETECT_GEM_VERDICT_
                                    // WINDOW (0.75 s) in detect mode, so
                                    // chord frames stop drawing at
                                    // `chDt < -0.75`; a latch threshold
                                    // at `-NOTEDETECT_GEM_VERDICT_WINDOW`
                                    // (i.e. exactly -0.75) is unreachable
                                    // because the draw gate kicks the
                                    // frame out of the loop first. Place
                                    // the threshold ~0.55 s past line so
                                    // it fires for ~0.2 s of the remaining
                                    // visible window — enough frames to
                                    // catch and skip future re-scans.
                                    //
                                    // The !anyState guard keeps the
                                    // partial-resolve case (one cn 'hit',
                                    // another still null) scanning until
                                    // anyMiss / allHit commits it.
                                    _chordVerdicts.set(verdictKey, 'unmatched');
                                }
                                // else: no verdict yet → leave teal default
                            }
                        }

                        const repDim = isRepeat ? 0.78 : 1;
                        const edgeOp = fade * repDim * CHORD_BOX_EDGE_ALPHA * (isRepeat ? 0.85 : 1) * chordTailMul;
                        const thickZ = Math.max(CHORD_FRAME_RIM_Z_MIN * K, ft * CHORD_FRAME_RIM_Z_SCAL);
                        const drawFrameBox = (px, py, sx, sy, ord) => {
                            const b = pChordBox.get();
                            b.renderOrder = ord;
                            b.material.color.setHex(rimHex);
                            b.position.set(px, py, z);
                            b.scale.set(sx, sy, thickZ);
                            b.rotation.set(0, 0, 0);
                            b.material.opacity = edgeOp;
                        };

                        const innerW = Math.max(width - 2 * ftSide, width * 0.45);
                        const innerH = Math.max(height - 2 * ft, height * 0.3);
                        const fill = pChordFrameFill.get();
                        fill.renderOrder = 10;
                        fill.rotation.set(0, 0, 0);
                        fill.position.set(cx, cY, z - 0.004 * K);
                        fill.scale.set(innerW, innerH, 1);
                        fill.material.opacity = fade * repDim * chordTailMul;
                        // Swapping `map` between two non-null gradient textures
                        // doesn't change shader-defining state, so no needsUpdate
                        // — that flag would otherwise force a recompile per frame.
                        fill.material.map = isArpeggioFrame ? chordFrameGradTexArp : chordFrameGradTex;
                        fill.material.color.setRGB(1, 1, 1);

                        // renderOrder 17/18 — above sustain rails (16) but below note gems (20/21)
                        drawFrameBox(cx, yBot + ft * 0.5, width, ft, 17);
                        const withTopFrame = !isRepeat;
                        if (withTopFrame) {
                            drawFrameBox(cx, yTop - ft * 0.5, width, ft, 17);
                        }

                        const ySideLo = yBot + ft;
                        const ySideHi = withTopFrame ? yTop - ft : yTop - ft * 0.15;
                        const sideH = Math.max(ySideHi - ySideLo, ft * 1.25);
                        const sideCy = ySideLo + sideH * 0.5;
                        drawFrameBox(cx - width * 0.5 + ftSide * 0.5, sideCy, ftSide, sideH, 18);
                        drawFrameBox(cx + width * 0.5 - ftSide * 0.5, sideCy, ftSide, sideH, 18);

                        // Accent bloom on frame edges: 4 additive shells with
                        // Gaussian-style falloff. Each border expands only in its
                        // perpendicular axis so bloom never leaves the frame boundary:
                        //   horizontal bars (top/bottom) → expand Y only
                        //   vertical bars (left/right)   → expand X only
                        if (chordAccent && pChordAccentHalo) {
                            const haloHex = isArpeggioFrame ? ARPEGGIO_RIM_BLUE_HEX : CHORD_BOX_TEAL_HEX;
                            const bloomShells = [
                                [1.00, 0.90],
                                [1.10, 0.65],
                                [1.25, 0.38],
                                [1.45, 0.18],
                            ];
                            // ex, ey: expand multiplier per axis
                            const drawHalo = (px, py, sx, sy, ex, ey, op) => {
                                const b = pChordAccentHalo.get();
                                b.material.color.setHex(haloHex);
                                b.material.opacity = fade * op * chordTailMul;
                                b.renderOrder = 19;
                                b.position.set(px, py, z - 0.001 * K);
                                b.scale.set(sx * ex, sy * ey, thickZ * 2.0);
                                b.rotation.set(0, 0, 0);
                            };
                            for (const [expand, op] of bloomShells) {
                                // horizontal bars — expand Y only
                                drawHalo(cx, yBot + ft * 0.5,                         width,  ft,    1.0, expand, op);
                                if (withTopFrame)
                                drawHalo(cx, yTop - ft * 0.5,                         width,  ft,    1.0, expand, op);
                                // vertical bars — expand X only
                                drawHalo(cx - width * 0.5 + ftSide * 0.5, sideCy, ftSide, sideH, expand, 1.0, op);
                                drawHalo(cx + width * 0.5 - ftSide * 0.5, sideCy, ftSide, sideH, expand, 1.0, op);
                            }
                        }

                        const chordName = chordTemplateLabel(bundle.chordTemplates?.[ch.id]);
                        if (chordName && firstInShapeRun && !chordWireHighDensity(ch)) {
                            const lblW = 28 * K, lblH = 9 * K;
                            const lbl = pChordLbl.get();
                            const mat = txtMat(chordName, '#e8d080', true, 'chord');
                            if (lbl.material.map !== mat.map) { lbl.material.map = mat.map; lbl.material.needsUpdate = true; }
                            lbl.material.opacity = Math.min(1, 0.3 + fade * 0.7) * chordTailMul;
                            // Gold chord name: slight +X shift from flush-left so it sits farther right.
                            const lblWS = lblW * _textSizeMul;
                            const lblHS = lblH * _textSizeMul;
                            const frameLeft = cx - width / 2;
                            const nameShiftX = NW * 0.94;
                            const nameVertTuck = NH * 0.02;
                            lbl.position.set(
                                frameLeft - lblWS / 2 + nameShiftX,
                                yMaxF + lblHS / 2 - nameVertTuck,
                                z);
                            lbl.scale.set(lblWS, lblHS, 1);
                        }

                        // Shape-based barre detection for the 3D indicator.
                        // Drives off chord notes alone — independent of label
                        // availability, so charts whose chordTemplates lack a
                        // .name still show the barre line.
                        // Matches drawChordDiagram PATH A + PATH B so the highway
                        // line and overlay bracket always agree on the same shapes:
                        //   PATH A: 2+ adjacent strings at the minimum fret.
                        //   PATH B: outer-edge full-span barre (e.g. B major x24442)
                        //           where the two outer strings are at the minimum fret,
                        //           every intermediate string is fretted (f>0), and no
                        //           intermediate string also sits at the minimum fret.
                        // Scattered voicings like "1 3 1 3 1 0" (strings 0,2,4 at
                        // fret 1 but no two adjacent, and string 2 sits at min fret)
                        // correctly produce no indicator.
                        {
                            let bFret = Infinity;
                            for (const [, f] of chShape) {
                                if (f > 0) bFret = Math.min(bFret, f);
                            }
                            const atMinFretStrings = bFret < Infinity
                                ? [...chShape].filter(([, f]) => f === bFret).map(([s]) => s).sort((a, b) => a - b)
                                : [];
                            const barreRun3d = longestConsecutiveRun(atMinFretStrings);
                            let is3dBarre    = barreRun3d.length >= 2;   // PATH A
                            let barreMinStr3d = is3dBarre ? barreRun3d[0] : -1;
                            let barreMaxStr3d = is3dBarre ? barreRun3d[barreRun3d.length - 1] : -1;

                            // PATH B: outer-edge full-span barre
                            const MIN_BARRE_SPAN_3D = Math.min(nStr - 1, 4);
                            if (atMinFretStrings.length >= 2) {
                                const minS = atMinFretStrings[0];
                                const maxS = atMinFretStrings[atMinFretStrings.length - 1];
                                if (maxS - minS >= MIN_BARRE_SPAN_3D) {
                                    const frettedSet = new Set();
                                    for (const [s, f] of chShape) {
                                        if (f > 0) frettedSet.add(s);
                                    }
                                    let allFretted = true;
                                    for (let si = minS; si <= maxS; si++) {
                                        if (!frettedSet.has(si)) { allFretted = false; break; }
                                    }
                                    if (allFretted) {
                                        if (is3dBarre) {
                                            // PATH A fired: extend to full outer span.
                                            barreMinStr3d = minS; barreMaxStr3d = maxS;
                                        } else {
                                            // PATH A did not fire: only draw if no inner
                                            // string also sits at the minimum fret.
                                            const innerAtMinFret = atMinFretStrings.some(s => s > minS && s < maxS);
                                            if (!innerAtMinFret) {
                                                is3dBarre = true;
                                                barreMinStr3d = minS; barreMaxStr3d = maxS;
                                            }
                                        }
                                    }
                                }
                            }

                            if (is3dBarre && chDt <= 0) {
                                const bx = xFretMid(bFret);
                                const yTop = Math.max(sY(barreMinStr3d), sY(barreMaxStr3d));
                                const yBot = Math.min(sY(barreMinStr3d), sY(barreMaxStr3d));
                                const lineH = yTop - yBot;
                                const bl = pBarreLine.get();
                                bl.position.set(bx, (yTop + yBot) / 2, 0.05 * K);
                                bl.scale.set(0.5 * K, lineH, 0.5 * K);
                                bl.material.opacity = 0.8 * chordTailMul;
                            }
                        }

                        // ── Palm-mute strum indicator — X outline + dark fill ──────────
                        // Eight lines forming a star/asterisk across the inner chord box,
                        // with a semi-transparent dark fill covering the same 5 regions.
                        // Geometry fractions: ±1 = inner-box edge, Y-up (Three.js).
                        if (isRepeat && chordNotes.some(cn => cn.pm)) {
                            // Fill (dark, transparent) — renderOrder 10 = below lines
                            const pmf = pPMXFill.get();
                            pmf.renderOrder = 10.5; // above pChordFrameFill (10), below X lines (11)
                            pmf.rotation.set(0, 0, 0);
                            pmf.position.set(cx, cY, z - 0.0045 * K);
                            pmf.scale.set(innerW * 0.5, -innerH * 0.5, 1); // Y negated: mirrors XLINES convention (ay = cY - fya*hH)
                            pmf.material.opacity = edgeOp;

                            const lw  = ft * 0.55;      // line visual thickness
                            const hW  = innerW * 0.5;
                            const hH  = innerH * 0.5;
                            // [fx_a, fy_a, fx_b, fy_b] — junction points where pairs converge
                            const XLINES = [
                                [-1.000, -0.500, -0.494, -0.011], // LET → L
                                [-1.000,  0.500, -0.494, -0.011], // LEB → L
                                [ 1.000, -0.500,  0.476, -0.011], // RET → R
                                [ 1.000,  0.500,  0.476, -0.011], // REB → R
                                [-0.480,  1.000, -0.012,  0.257], // BLC → B
                                [ 0.500,  1.000, -0.012,  0.257], // BRC → B
                                [ 0.480, -1.000,  0.000, -0.276], // TRC → T
                                [-0.480, -1.000, -0.006, -0.276], // TLC → T
                            ];
                            for (const [fxa, fya, fxb, fyb] of XLINES) {
                                const ax = cx + fxa * hW,  ay = cY - fya * hH;
                                const bx = cx + fxb * hW,  by = cY - fyb * hH;
                                const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
                                const len = Math.hypot(bx - ax, by - ay);
                                const ang = Math.atan2(by - ay, bx - ax);
                                const seg = pChordBox.get();
                                seg.renderOrder = 11;
                                seg.material.color.setHex(rimHex);
                                seg.position.set(mx, my, z - 0.005 * K);
                                seg.scale.set(len, lw, thickZ * 0.5);
                                seg.rotation.set(0, 0, ang);
                                seg.material.opacity = edgeOp * 0.85;
                            }
                        }

                        // ── Frethand-mute strum indicator — FH X outline + dark fill ───
                        // 4 convergence nodes (L,R,T,B) + 8 terminals on top/bottom borders.
                        // L/R wings stop at fx=±0.50 — no solid lateral fill blocks.
                        if (isRepeat && chordNotes.some(cn => cn.mt)) {
                            // Fill (dark) — renderOrder 10.5 = above frame fill, below X lines
                            const fhf = pFHXFill.get();
                            fhf.renderOrder = 10.5;
                            fhf.rotation.set(0, 0, 0);
                            fhf.position.set(cx, cY, z - 0.0045 * K);
                            fhf.scale.set(innerW * 0.5, -innerH * 0.5, 1); // Y negated: fy+ = up in geometry space
                            fhf.material.opacity = edgeOp;

                            const lw = ft * 0.55;
                            const hW = innerW * 0.5;
                            const hH = innerH * 0.5;
                            // [fx_a, fy_a, fx_b, fy_b]
                            const FH_XLINES = [
                                [-0.50,  1.00, -0.28,  0.00], // LET → L
                                [-0.50, -1.00, -0.28,  0.00], // LEB → L
                                [ 0.50,  1.00,  0.28,  0.00], // RET → R
                                [ 0.50, -1.00,  0.28,  0.00], // REB → R
                                [-0.15, -1.00,  0.00, -0.42], // BLC → B
                                [ 0.15, -1.00,  0.00, -0.42], // BRC → B
                                [ 0.15,  1.00,  0.00,  0.42], // TRC → T
                                [-0.15,  1.00,  0.00,  0.42], // TLC → T
                            ];
                            for (const [fxa, fya, fxb, fyb] of FH_XLINES) {
                                const ax = cx + fxa * hW,  ay = cY - fya * hH;
                                const bx = cx + fxb * hW,  by = cY - fyb * hH;
                                const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
                                const len = Math.hypot(bx - ax, by - ay);
                                const ang = Math.atan2(by - ay, bx - ax);
                                const seg = pChordBox.get();
                                seg.renderOrder = 11;
                                seg.material.color.setHex(rimHex);
                                seg.position.set(mx, my, z - 0.005 * K);
                                seg.scale.set(len, lw, thickZ * 0.5);
                                seg.rotation.set(0, 0, ang);
                                seg.material.opacity = edgeOp * 0.85;
                            }
                        }

                    }

                    // ── Chord sustain length indicator — 3D plane rails ─────────────
                    // Left + right rail as plane meshes (PlaneGeometry +
                    // MeshBasicMaterial) in the WebGL scene so they respect
                    // renderOrder (16) and never occlude note gems (20/21).
                    if (chShape.size > 1 && chordOpenBoxW != null && !isRepeat && chDt < AHEAD) {
                        const _effSus    = Math.max(maxSus, 0.4);
                        const _dtSusEnd  = chDt + _effSus;
                        if (_dtSusEnd > 0) {
                            const _zNear = chDt > 0 ? dZ(chDt) : 0;
                            const _zFar  = dZ(Math.min(_dtSusEnd, AHEAD));
                            const _railLen = _zNear - _zFar;
                            if (_railLen > 0.001) {
                                const _yA   = sY(0), _yB = sY(nStr - 1);
                                const _yBot = Math.min(_yA, _yB) - S_GAP * 0.8;
                                const _fadeAhead = chDt > 0 ? Math.max(0, 1 - chDt / AHEAD) : 1;
                                const _fadeSus   = Math.min(1, _dtSusEnd / 0.25);
                                const _op  = _fadeAhead * _fadeSus * 0.9;
                                const _hex = chordHighwayLavenderArpVisual ? ARPEGGIO_RIM_BLUE_HEX : CHORD_BOX_TEAL_HEX;
                                const _railW = 2.5 * K; // visual width of each rail strip
                                const _zMid  = _zNear - _railLen * 0.5; // centre in Z
                                for (const _rx of [chordFrameXL, chordFrameXR]) {
                                    // Core rail
                                    const rl = pSusRail.get();
                                    rl.material.color.setHex(_hex);
                                    rl.material.opacity = _op;
                                    rl.position.set(_rx, _yBot, _zMid);
                                    rl.scale.set(_railW, 1, _railLen);
                                    // Bloom glow — wider gaussian plane, additive blending
                                    const bl = pSusRailBloom.get();
                                    bl.material.color.setHex(_hex);
                                    bl.material.opacity = _op * 0.8;
                                    bl.position.set(_rx, _yBot + 0.001, _zMid);
                                    bl.scale.set(4 * K, 1, _railLen);
                                }
                            }
                        }
                    }
                }
            }

            // Fret span of the dynamic highway lane (wire dMin .. dMax). Reused
            // so fret-column measure markers stay inside the same horizontal
            // band as the blue track — previously markers used every inlay
            // fret and stuck out past the lane whenever the camera narrowed.
            let hwyLaneFretClipMin = null, hwyLaneFretClipMax = null;

            const handShapesRails = bundle.handShapes;
            hwyLaneArpOuterDividers = !!(handShapesRails && handShapesRails.length && laneRailArpHsFlags
                && arpeggioLaneOuterRailAtChartTime(
                    now, handShapesRails, laneRailBoundLo, laneRailBoundHi, laneRailArpHsFlags,
                ));
            const arpLaneRimAccentMul = hwyLaneArpOuterDividers && laneRailArpHsFlags && handShapesRails
                ? arpeggioLaneDividerFrameAccentMul(
                    now, handShapesRails, chords, laneRailBoundLo, laneRailBoundHi, laneRailArpHsFlags,
                )
                : 1;
            const arpLaneS = hwyLaneArpOuterDividers
                ? arpeggioLaneDividerXYScaleMatchFrameRim(arpLaneRimAccentMul)
                : 1;

            // ── Dynamic highway lane ──────────────────────────────────────
            // Chart <anchor> tags drive the lane whenever they exist — do not
            // require nearby notes (activeFrets) or camera-driven activity.
            const hasChartAnchors = anchors && anchors.length;
            if (hasChartAnchors || activeFrets.size > 0) {
                // Lane tint: one translucent quad per playable fret column, exact
                // wire→wire span (no horizontal pad) — see HWY_LANE_STRIPE_*.
                const boardY = S_BASE - NH / 2 - 2 * K;

                if (hasChartAnchors) {
                    const nearB = laneBoundsFromAnchor(getChartAnchorAt(anchors, now));
                    if (nearB) {
                        hwyLaneFretClipMin = nearB.dMin;
                        hwyLaneFretClipMax = nearB.dMax;
                    }

                    const sliceDt = AHEAD / HWY_LANE_TIME_SLICES;
                    // Single-pass build-and-merge into the parallel-array
                    // scratch buffers. Consecutive slices that resolve to the
                    // same anchor bounds collapse into one segment by extending
                    // its z1; otherwise a new entry appends. No per-frame array
                    // or {b,z0,z1} object allocations.
                    _laneSegLen = 0;
                    for (let k = 0; k < HWY_LANE_TIME_SLICES; k++) {
                        const dt0 = k * sliceDt;
                        const dt1 = (k + 1) * sliceDt;
                        const tC = now + (dt0 + dt1) * 0.5 - BEHIND;
                        const b = laneBoundsFromAnchor(getChartAnchorAt(anchors, tC));
                        if (!b) continue;
                        const z0 = dZ(dt0) + TS * BEHIND;
                        const z1 = dZ(dt1) + TS * BEHIND;
                        const arpSlice = (laneRailArpHsFlags && handShapesRails && handShapesRails.length)
                            ? arpeggioLaneOuterRailLaneSlice(
                                dt0, dt1, now,
                                handShapesRails, laneRailBoundLo, laneRailBoundHi, laneRailArpHsFlags,
                            )
                            : false;
                        if (_laneSegLen > 0
                            && _laneSegDMin[_laneSegLen - 1] === b.dMin
                            && _laneSegDMax[_laneSegLen - 1] === b.dMax
                            && arpSlice === _laneSegArp[_laneSegLen - 1]) {
                            _laneSegZ1[_laneSegLen - 1] = z1;
                            _laneSegTHi[_laneSegLen - 1] = tC;
                        } else if (_laneSegLen > 0
                            && _laneSegDMin[_laneSegLen - 1] === b.dMin
                            && _laneSegDMax[_laneSegLen - 1] === b.dMax
                            && arpSlice !== _laneSegArp[_laneSegLen - 1]) {
                            _laneSegDMin[_laneSegLen] = b.dMin;
                            _laneSegDMax[_laneSegLen] = b.dMax;
                            _laneSegZ0[_laneSegLen] = z0;
                            _laneSegZ1[_laneSegLen] = z1;
                            _laneSegTLo[_laneSegLen] = tC;
                            _laneSegTHi[_laneSegLen] = tC;
                            _laneSegArp[_laneSegLen] = arpSlice;
                            _laneSegLen++;
                        } else {
                            _laneSegDMin[_laneSegLen] = b.dMin;
                            _laneSegDMax[_laneSegLen] = b.dMax;
                            _laneSegZ0[_laneSegLen] = z0;
                            _laneSegZ1[_laneSegLen] = z1;
                            _laneSegTLo[_laneSegLen] = tC;
                            _laneSegTHi[_laneSegLen] = tC;
                            _laneSegArp[_laneSegLen] = arpSlice;
                            _laneSegLen++;
                        }
                    }
                    {
                        const laneOp = HWY_LANE_STRIPE_OP_BASE + highwayIntensity * HWY_LANE_STRIPE_OP_INT;
                        // 2 shared materials (odd/even); opacity travels via the
                        // material so set it once per frame, not per mesh.
                        mLaneOdd.opacity = laneOp;
                        mLaneEven.opacity = laneOp;
                        for (let s = 0; s < _laneSegLen; s++) {
                            const segZ0 = _laneSegZ0[s];
                            const segZ1 = _laneSegZ1[s];
                            const stripLen = Math.max(Math.abs(segZ1 - segZ0), 1e-6);
                            const zc = (segZ0 + segZ1) * 0.5;
                            const fLow = _laneSegDMin[s] + 1;
                            const fHi = _laneSegDMax[s];
                            for (let f = fLow; f <= fHi; f++) {
                                const xl = xFret(f - 1), xr = xFret(f);
                                const laneW = Math.abs(xr - xl);
                                const lane = pLane.get();
                                lane.position.set((xl + xr) * 0.5, boardY + 0.02 * K, zc);
                                lane.rotation.x = -Math.PI / 2;
                                lane.scale.set(laneW, stripLen, 1);
                                const odd = ((f - fLow) & 1) === 0;
                                lane.material = odd ? mLaneOdd : mLaneEven;
                                lane.renderOrder = 1;
                            }
                        }
                    }

                    {
                        const yPos = boardY + 0.03 * K;
                        const divOp = 0.02 + highwayIntensity * 0.1;
                        const divOpArp = Math.min(0.92, 0.16 + highwayIntensity * 0.42);
                        if (mLaneDivider && mLaneDividerArp) {
                            mLaneDivider.opacity = divOp;
                            mLaneDividerArp.opacity = divOpArp;
                        }

                        for (let s = 0; s < _laneSegLen; s++) {
                            const segZ0 = _laneSegZ0[s];
                            const segZ1 = _laneSegZ1[s];
                            const dz = Math.max(Math.abs(segZ1 - segZ0), 1e-6);
                            const zMid = (segZ0 + segZ1) * 0.5;
                            const dMinSeg = _laneSegDMin[s];
                            const dMaxSeg = _laneSegDMax[s];
                            const fDiv0 = Math.floor(dMinSeg);
                            const fDiv1 = Math.ceil(dMaxSeg);
                            for (let f = fDiv0; f <= fDiv1; f++) {
                                if (_laneSegArp[s] && (f === fDiv0 || f === fDiv1)) continue;
                                const div = pLaneDivider.get();
                                div.position.set(xFret(f), yPos, zMid);
                                div.material = mLaneDivider;
                                div.scale.set(1, 1, dz);
                                div.renderOrder = 2;
                            }
                        }
                        for (let s = 0; s < _laneSegLen; s++) {
                            if (!_laneSegArp[s]) continue;
                            const dMinSeg = _laneSegDMin[s];
                            const dMaxSeg = _laneSegDMax[s];
                            const fL = Math.floor(dMinSeg);
                            const fR = Math.ceil(dMaxSeg);
                            const segZ0 = _laneSegZ0[s];
                            const segZ1 = _laneSegZ1[s];
                            const arpRailLen = Math.max(Math.abs(segZ1 - segZ0), 1e-6);
                            const zArpMid = (segZ0 + segZ1) * 0.5;
                            const tMidSeg = (_laneSegTLo[s] + _laneSegTHi[s]) * 0.5;
                            const arpMulSeg = (laneRailArpHsFlags && handShapesRails && handShapesRails.length)
                                ? arpeggioLaneDividerFrameAccentMul(
                                    tMidSeg, handShapesRails, chords,
                                    laneRailBoundLo, laneRailBoundHi, laneRailArpHsFlags,
                                )
                                : 1;
                            const arpSSeg = arpeggioLaneDividerXYScaleMatchFrameRim(arpMulSeg);
                            for (const xf of [fL, fR]) {
                                const div = pLaneDivider.get();
                                div.position.set(xFret(xf), yPos, zArpMid);
                                div.material = mLaneDividerArp;
                                div.scale.set(arpSSeg, arpSSeg, arpRailLen);
                                div.renderOrder = 2;
                            }
                        }
                    }
                } else {
                    let dMin, dMax;
                    let divMin, divMax;
                    let minF = 99, maxF = 0;
                    activeFrets.forEach(f => { if (f > 0) { minF = Math.min(minF, f); maxF = Math.max(maxF, f); } });
                    dMin = minF - 1;
                    dMax = maxF;
                    const HWY_LANE_SPAN = 4;
                    let span = dMax - dMin;
                    if (span > HWY_LANE_SPAN) {
                        dMin = Math.round((dMin + dMax - HWY_LANE_SPAN) / 2);
                        dMax = dMin + HWY_LANE_SPAN;
                        if (dMax > NFRETS) {
                            dMax = NFRETS;
                            dMin = dMax - HWY_LANE_SPAN;
                        }
                        if (dMin < 0) {
                            dMin = 0;
                            dMax = HWY_LANE_SPAN;
                        }
                    } else if (span < HWY_LANE_SPAN) {
                        const need = HWY_LANE_SPAN - span;
                        dMax = Math.min(NFRETS, dMax + need);
                        if (dMax - dMin < HWY_LANE_SPAN) {
                            dMin = Math.max(0, dMin - (HWY_LANE_SPAN - (dMax - dMin)));
                        }
                    }
                    if (dMax < dMin) dMax = dMin;
                    hwyLaneFretClipMin = dMin;
                    hwyLaneFretClipMax = dMax;
                    divMin = dMin;
                    divMax = dMax;

                    const laneLen = TS * AHEAD;
                    const zLane = -laneLen / 2 + TS * BEHIND;
                    const laneOp = HWY_LANE_STRIPE_OP_BASE + highwayIntensity * HWY_LANE_STRIPE_OP_INT;
                    mLaneOdd.opacity = laneOp;
                    mLaneEven.opacity = laneOp;
                    const fLow = dMin + 1;
                    const fHi = dMax;
                    for (let f = fLow; f <= fHi; f++) {
                        const xl = xFret(f - 1), xr = xFret(f);
                        const laneWStrip = Math.abs(xr - xl);
                        const lane = pLane.get();
                        lane.position.set((xl + xr) / 2, boardY + 0.02 * K, zLane);
                        lane.rotation.x = -Math.PI / 2;
                        lane.scale.set(laneWStrip, laneLen, 1);
                        const odd = ((f - fLow) & 1) === 0;
                        lane.material = odd ? mLaneOdd : mLaneEven;
                        lane.renderOrder = 1;
                    }

                    if (highwayIntensity > 0.05) {
                        const divLen = TS * (AHEAD + BEHIND) * 0.6;
                        const yPos = boardY + 0.03 * K;
                        const divOp2 = 0.02 + highwayIntensity * 0.1;
                        const divOpArp2 = Math.min(0.92, 0.16 + highwayIntensity * 0.42);
                        if (mLaneDivider && mLaneDividerArp) {
                            mLaneDivider.opacity = divOp2;
                            mLaneDividerArp.opacity = divOpArp2;
                        }
                        const fDivA = Math.floor(divMin);
                        const fDivB = Math.ceil(divMax);
                        for (let f = fDivA; f <= fDivB; f++) {
                            if (hwyLaneArpOuterDividers && (f === fDivA || f === fDivB)) continue;
                            const div = pLaneDivider.get();
                            div.position.set(xFret(f), yPos, dZ(0) - divLen * 0.5 + TS * BEHIND);
                            div.material = mLaneDivider;
                            div.scale.set(1, 1, divLen);
                            div.renderOrder = 2;
                        }
                        if (hwyLaneArpOuterDividers) {
                            for (const xf of [fDivA, fDivB]) {
                                const div = pLaneDivider.get();
                                div.position.set(xFret(xf), yPos, zLane);
                                div.material = mLaneDividerArp;
                                div.scale.set(arpLaneS, arpLaneS, laneLen);
                                div.renderOrder = 2;
                            }
                        }
                    }
                }
            }

            // ── Dynamic fret number row (heat-coloured) ───────────────────
            // Two-part fix for issue #35:
            //  1. renderOrder = 1000 forces these sprites to the end of
            //     the transparent queue so they always paint on top of
            //     notes, sustain trails, lane plane, etc. depthTest is
            //     already disabled by txtMat(), but `depthTest: false`
            //     only exempts the sprite from depth comparison — it
            //     doesn't pin draw order. Without an explicit
            //     renderOrder, a note rendered after the label in the
            //     transparent pass would still overdraw it. Match the
            //     pattern already used for lane and dividers.
            //  2. Y-offset bumped from S_GAP * 0.6 to S_GAP * 1.4 so the
            //     label band sits clearly below the lowest string in
            //     screen space, even at the largest active scale
            //     (intensity-driven, up to ~5.7 * K vertical extent).
            //     This buys a real visual gap between notes-on-the-
            //     lowest-string and the row, on top of the renderOrder
            //     guarantee — labels never share screen with what's
            //     happening on the playing strings just above them.
            {
                const yBottom = Math.min(sY(0), sY(nStr - 1));
                const anchorGold = anchorPlayedFretSpanAt(anchors, now);
                for (let f = 1; f <= NFRETS; f++) {
                    const lb = pFretLbl.get();
                    const isGold = anchorGold
                        ? (f >= anchorGold.f0 && f <= anchorGold.f1)
                        : activeFrets.has(f);
                    lb.material    = txtMat(f, isGold ? FRET_LABEL_GOLD_HEX : FRET_LABEL_IDLE_HEX, false, 'fretRow');
                    lb.position.set(xFretMid(f), yBottom - S_GAP * 1.4, 0.5 * K);
                    const intensity = noteState.fretHeat[f];
                    lb.material.opacity = 0.35 + intensity * 0.65;
                    const scale = (3.5 + intensity * 2.2) * _textSizeMul * fretLabelScaleForFret(f);
                    lb.scale.set(scale * K, scale * K, 1);
                    lb.renderOrder = 1000;
                }
            }

            // ── Beat lines ────────────────────────────────────────────────
            if (beats) {
                const board = boardSpanX();
                const bw2 = board.width + 4 * K;
                let lastM = -1;
                for (const b of beats) {
                    const meas = b.measure !== lastM; lastM = b.measure;
                    if (b.time < t0 || b.time > t1) continue;
                    const bl2 = pBeat.get();
                    bl2.material = meas ? mBeatM : mBeatQ;
                    bl2.scale.set(bw2, 1, 1);
                    bl2.position.set(board.min - 2 * K, S_BASE - NH / 2 - 1.5 * K, dZ(b.time - now));
                }
            }

            // ── Section labels ────────────────────────────────────────────
            // Gated on sectionLabelsOnHighway (advanced setting, default off).
            // The HUD card (drawSectionHud, called from the lyricsCtx block in
            // draw()) is the primary surface for section info; the on-highway
            // sprites are kept as an opt-in for users who want the in-scene cue.
            if (sections && sectionLabelsOnHighway) {
                const labelY = Math.max(sY(0), sY(nStr - 1)) + 8 * K;
                for (const s of sections) {
                    if (s.time < t0 || s.time > t1) continue;
                    const sp = pSec.get();
                    sp.material = txtMat(s.name, '#00cccc', true, 'section');
                    sp.scale.set(20 * K * _textSizeMul, 5 * K * _textSizeMul, 1);
                    sp.position.set(xFret(12), labelY, dZ(s.time - now));
                }
            }

            // ── Fret-column reference markers ─────────────────────────────
            // Every Nth measure, spawn a row of fret-number sprites on the
            // board floor that scroll toward the hit line and vanish at Z=0.
            // With a chart <anchor>, which frets appear follows the inlay
            // cadence (DOTS) centred on the snapped anchor fret (~2 positions
            // back and ~3 forward in that list, e.g. anchor 7 → 3,5,7,9,12,15).
            // Without anchors, all DOTS positions are candidates; octave + lane
            // clipping apply. With <anchor>, the cadence row ignores both so
            // frets before/after the lane still show as reference. Light grey
            // when that fret is in the active set, dark grey otherwise.
            //
            // Per-wave gate cache: hasLow/hasHigh/fretList snapshotted at first
            // sight of a wave so the render decision stays stable through
            // the wave's full flight. Without this, activeFrets shifting
            // mid-song would drop markers mid-flight (user-reported bug:
            // "numbers disappear before they get all the way towards me").
            if (beats && fretColumnMarkerCadence > 0) {
                // Prune stale wave cache entries (wave already past now).
                if (_fretMarkerWaveCache.size > 0) {
                    for (const k of _fretMarkerWaveCache.keys()) {
                        if (k < now) _fretMarkerWaveCache.delete(k);
                    }
                }
                const minStringY = Math.min(sY(0), sY(nStr - 1));
                const labelY = minStringY - S_GAP * 0.8;
                for (const b of beats) {
                    // Non-downbeats are encoded as measure=-1; only actual
                    // measure starts (measure >= 0) can spawn marker waves.
                    if (b.measure < 0) continue;
                    if (b.time < 0 || b.time > t1) continue;
                    if (b.time <= now) continue;
                    if ((b.measure | 0) % fretColumnMarkerCadence !== 0) continue;

                    // Snapshot the active-range gate at first sight of this
                    // wave. We scan notes/chords in a 2s window starting at
                    // b.time rather than activeFrets, because activeFrets only
                    // covers now+2s and waves first become visible up to
                    // AHEAD (3s) ahead — using activeFrets would cache
                    // {hasLow:false, hasHigh:false} for far waves and suppress
                    // the entire row for its full flight.
                    let cached = _fretMarkerWaveCache.get(b.time);
                    if (!cached) {
                        let hasLow = false, hasHigh = false;
                        const wT0 = b.time, wT1 = b.time + 2;
                        // notes and chords are time-sorted; binary-search to the
                        // first entry >= wT0, then break once past wT1 to avoid
                        // O(song_length) work per newly-seen wave.
                        if (notes) {
                            const startI = lowerBoundT(notes, wT0);
                            for (let i = startI; i < notes.length; i++) {
                                const n = notes[i];
                                if (n.t > wT1) break;
                                if (!validString(n.s) || n.f <= 0) continue;
                                if (n.f <= 12) hasLow = true; else hasHigh = true;
                                if (hasLow && hasHigh) break;
                            }
                        }
                        if ((!hasLow || !hasHigh) && chords) {
                            const startI = lowerBoundT(chords, wT0);
                            outer: for (let i = startI; i < chords.length; i++) {
                                const ch = chords[i];
                                if (ch.t > wT1) break outer;
                                if (!ch.notes) continue;
                                for (const cn of ch.notes) {
                                    if (!validString(cn.s) || cn.f <= 0) continue;
                                    if (cn.f <= 12) hasLow = true; else hasHigh = true;
                                    if (hasLow && hasHigh) break outer;
                                }
                            }
                        }
                        const anc = anchors && anchors.length ? getChartAnchorAt(anchors, b.time) : null;
                        const anchorFret = anc != null ? Number(anc.fret) : NaN;
                        const anchorKeyed = Number.isFinite(anchorFret) && anchorFret >= 0;
                        const fretList = anchorKeyed
                            ? fretColumnMarkersForAnchor(anchorFret, DOTS)
                            : DOTS.slice();
                        cached = { hasLow, hasHigh, fretList, anchorKeyed };
                        _fretMarkerWaveCache.set(b.time, cached);
                    }
                    if (!cached.hasLow && !cached.hasHigh && !cached.anchorKeyed) continue;

                    const dt = b.time - now;
                    const z = dZ(dt);
                    // Sprite scale matches the per-note connector fret label
                    // (drawNote → pNoteFretLabel) so cadence markers read the
                    // same size at a given Z — no extra world-scale boost.
                    const clipMin = hwyLaneFretClipMin;
                    const clipMax = hwyLaneFretClipMax;
                    const fretList = cached.fretList || DOTS;
                    const anchorKeyedRow = !!cached.anchorKeyed;
                    for (const f of fretList) {
                        let show;
                        if (anchorKeyedRow) {
                            show = true;
                        } else {
                            if (f === 12) show = cached.hasLow || cached.hasHigh;
                            else if (f < 12) show = cached.hasLow;
                            else show = cached.hasHigh;
                        }
                        if (!show) continue;
                        if (!anchorKeyedRow && clipMin != null && (f <= clipMin || f > clipMax)) continue;
                        const lit = activeFrets.has(f);
                        const color = lit ? '#bbbbbb' : '#666666';
                        const sp = pFretColMarker.get();
                        const m = txtMat(f, color, false, 'noteFret');
                        if (sp.material.map !== m.map) {
                            sp.material.map = m.map;
                            sp.material.needsUpdate = true;
                        }
                        sp.material.opacity = 0.85;
                        sp.position.set(xFretMid(f), labelY, z);
                        const sz = NH * 2.2 * _textSizeMul * fretLabelScaleForFret(f);
                        sp.scale.set(sz, sz, 1);
                    }
                }
            }

            // ── Camera target ─────────────────────────────────────────────
            let lockActive;
            if (!(cameraMode === 'lookahead')) {
                lockActive = _applyNoteCamTargets(
                    camWX, camWSum, camDistMin, camDistMax, camDistGot,
                    camHystF, camDistHystF, /* skipDistHyst= */ false);
                prevLockActive = lockActive;
            } else {
                const lookaheadMaxF = lookaheadBoundsNow ? lookaheadBoundsNow.maxF : 0;
                const lookaheadHasBounds = lookaheadBoundsNow != null;

                let dtSec = 1 / 120;
                if (_lookaheadCamPrevNow !== null) {
                    const rawDt = bundle.currentTime - _lookaheadCamPrevNow;
                    if (rawDt > -1 && rawDt < 2) dtSec = Math.min(0.2, Math.max(1 / 960, rawDt));
                }
                _lookaheadCamPrevNow = bundle.currentTime;
                const dBlend = Math.min(0.2, Math.max(1e-4, dtSec));
                const lowBlendFs = 1 - Math.pow(1 - CAM_FOCUS_BLEND_RATE, dBlend);

                if (!lookaheadHasBounds || lookaheadMaxF <= LOOKAHEAD_LOCK_ENGAGE_MAXF)
                    _lookaheadHiNeckLatch = false;
                else if (lookaheadMaxF >= LOOKAHEAD_LOCK_RELEASE_MAXF)
                    _lookaheadHiNeckLatch = true;

                const lookaheadLockLowEligible = cameraLockLow
                    && (!lookaheadHasBounds
                        || (!_lookaheadHiNeckLatch && lookaheadMaxF <= 12));

                let rawLowBU;
                if (lookaheadLockLowEligible) {
                    rawLowBU = camLowFretPullbackU(1);
                } else if (lookaheadBoundsNow) {
                    rawLowBU = camLowFretPullbackU(lookaheadBoundsNow.minF);
                } else {
                    rawLowBU = camLowFretPullbackU(CAM_LOCK_CENTER_FRET);
                }
                _lookaheadLowBonusU = rawLowBU * lowBlendFs + _lookaheadLowBonusU * (1 - lowBlendFs);

                if (lookaheadLockLowEligible) {
                    const lockedBaseU = camBaseDistU(12);
                    const lockZoomMul = CAM_LOCK_ZOOM_MIN +
                        (CAM_LOCK_ZOOM_MAX - CAM_LOCK_ZOOM_MIN) * cameraLockZoom;
                    lookaheadSmoothCamStep(dtSec, xFretMid(CAM_LOCK_CENTER_FRET), 12);
                    tgtX = _lookaheadCamX;
                    tgtDist = (lockedBaseU + _lookaheadLowBonusU) * K * lockZoomMul;
                    prevLowFretBonus = _lookaheadLowBonusU;
                    lockActive = true;
                } else {
                    if (lookaheadBoundsNow) {
                        const tgtWX = lookaheadTargetWorldX(
                            lookaheadBoundsNow.minF, lookaheadBoundsNow.maxF);
                        const tgtSpanInt = Math.max(
                            1, lookaheadBoundsNow.maxF - lookaheadBoundsNow.minF + 1);
                        lookaheadSmoothCamStep(dtSec, tgtWX, tgtSpanInt);
                        tgtDist = (camBaseDistU(_lookaheadFretSpan) + _lookaheadLowBonusU) * K;
                        prevLowFretBonus = _lookaheadLowBonusU;
                    } else {
                        lookaheadSmoothCamStep(dtSec, _lookaheadCamX, _lookaheadFretSpan);
                        tgtDist = (camBaseDistU(_lookaheadFretSpan) + _lookaheadLowBonusU) * K;
                        prevLowFretBonus = _lookaheadLowBonusU;
                    }
                    tgtX = _lookaheadCamX;
                    lockActive = false;
                }
                prevLockActive = lockActive;
            }

            // ── Chord diagram: track chord, drive entrance + crossfade animations ─
            {
                let newChord = null;
                if (chords) {
                    let bestT = -Infinity;
                    for (const ch of chords) {
                        if (!ch.notes) continue;
                        const chDt = ch.t - now;
                        if (chDt <= 0 && chDt > -DIAG_LINGER_S) {
                            const tmpl = bundle.chordTemplates?.[ch.id];
                            const lbl = chordTemplateLabel(tmpl);
                            if (lbl && tmpl?.frets && ch.t > bestT) {
                                bestT = ch.t;
                                newChord = { name: lbl, frets: tmpl.frets, t: ch.t, t0: ch.t, chDt, nStr };
                            }
                        }
                    }
                }

                // Include frets in the key so two templates sharing a display name but
                // differing in fingering each trigger a fresh crossfade/entrance.
                const newKey = newChord ? newChord.name + '|' + newChord.frets.join(',') : null;
                if (newKey !== _diagLastKey) {
                    if (_diagChord && newKey !== null) {
                        // Recompute outgoing alpha from stored event time rather than the
                        // stale per-frame chDt; after dropped frames or seeks this prevents
                        // the overlay jumping to a stale brightness before the crossfade.
                        const freshChDt = _diagChord.t !== undefined ? _diagChord.t - now : _diagChord.chDt;
                        const prevOpacity = Math.max(0, Math.min(1, 1 + freshChDt / DIAG_LINGER_S));
                        // Only crossfade when the outgoing chord is actually visible at now.
                        // freshChDt > 0 means the old chord is in the future (backward seek
                        // crossed the chord boundary).  In that case _diagChord is stale, so
                        // recompute the outgoing diagram from the chart — find the most recent
                        // named chord that ends just before newChord.t and use it as _diagPrev
                        // so that seeking into a historical chord transition fades correctly
                        // rather than snapping straight to the new chord.
                        if (freshChDt <= 0 && prevOpacity > 0) {
                            // Use the string count the outgoing chord was captured with, not the
                            // current nStr — an arrangement switch during a 150 ms crossfade
                            // must not remap the outgoing diagram onto the new layout.
                            _diagPrev = { name: _diagChord.name, frets: _diagChord.frets, nStr: _diagChord.nStr ?? nStr, t: _diagChord.t0 ?? _diagChord.t ?? now };
                            _diagPrevStartOpacity = prevOpacity;
                            _diagPrevOpacity = prevOpacity;
                            _diagPrevStartT = now;
                            // entranceT for the outgoing diagram is computed live from _diagPrev.t
                            // each frame (see draw path), so it rewinds correctly on backward seeks
                            // within the crossfade window — no separate snapped state needed here.
                        } else if (freshChDt > 0) {
                            // Backward seek: _diagChord is now in the future.
                            // Look up the chart chord immediately before newChord.t to provide
                            // the correct historical outgoing diagram for the crossfade.
                            let histPrev = null;
                            if (chords && newChord) {
                                let bestPrevT = -Infinity;
                                for (const ch of chords) {
                                    if (!ch.notes) continue;
                                    const tmpl = bundle.chordTemplates?.[ch.id];
                                    const lbl = chordTemplateLabel(tmpl);
                                    if (lbl && tmpl?.frets && ch.t < newChord.t && ch.t > bestPrevT) {
                                        bestPrevT = ch.t;
                                        histPrev = { name: lbl, frets: tmpl.frets, t: ch.t, t0: ch.t, nStr };
                                    }
                                }
                            }
                            // Only start a crossfade if we are still within DIAG_CROSSFADE_S of
                            // newChord.t; seeking further into the chord skips the crossfade.
                            // Also skip if histPrev was no longer visible when newChord started
                            // (gap longer than DIAG_LINGER_S), so only genuinely adjacent chord
                            // transitions produce a crossfade — not seeks to just after any new
                            // chord that happens to have an older chord somewhere earlier in the song.
                            const elapsed = newChord ? now - newChord.t : Infinity;
                            const histPrevVisible = histPrev && (newChord.t - histPrev.t) < DIAG_LINGER_S;
                            if (histPrevVisible && elapsed >= 0 && elapsed < DIAG_CROSSFADE_S) {
                                // Start at the linger opacity the outgoing chord would have had at
                                // newChord.t during forward playback, not always 1.  This prevents
                                // a chord that was mostly faded from appearing brighter on a seek.
                                const histStartOpacity = Math.max(0, Math.min(1,
                                    1 - (newChord.t - histPrev.t) / DIAG_LINGER_S));
                                _diagPrev = histPrev;
                                _diagPrevStartOpacity = histStartOpacity;
                                _diagPrevOpacity = Math.max(0, histStartOpacity * (1 - elapsed / DIAG_CROSSFADE_S));
                                _diagPrevStartT = newChord.t;
                            } else {
                                _diagPrev = null; _diagPrevOpacity = 0; _diagPrevStartOpacity = 0;
                                _diagPrevStartT = null;
                            }
                        } else {
                            // prevOpacity <= 0: old chord already fully faded, no crossfade needed.
                            _diagPrev = null; _diagPrevOpacity = 0; _diagPrevStartOpacity = 0;
                            _diagPrevStartT = null;
                        }
                    } else {
                        _diagPrev = null; _diagPrevOpacity = 0; _diagPrevStartOpacity = 0;
                        _diagPrevStartT = null;
                    }
                    _diagLastKey = newKey;
                    // Only update _diagChord when the chord key actually changes so that a
                    // lingering chord's original nStr is preserved on subsequent frames.
                    // (newChord is rebuilt every frame with the live nStr; unconditionally
                    // assigning here would stomp the captured nStr if the arrangement switches
                    // while the same chord is still in its linger window.)
                    _diagChord = newChord;
                } else if (newKey !== null && newChord && _diagChord) {
                    // Same chord re-seen. Update linger expiry (t) when the event time changes.
                    // Forward restrum (newChord.t > _diagChord.t): extend the linger window
                    // but preserve t0 so the entrance animation is NOT replayed — avoids the
                    // overlay jumping back to its 0.85× scale on every strum of the same chord.
                    // Backward seek to earlier occurrence (newChord.t < _diagChord.t): update
                    // both t and t0 to restart the entrance animation from the earlier position.
                    if (newChord.t !== _diagChord.t) {
                        _diagChord = newChord.t < _diagChord.t
                            ? { ..._diagChord, t: newChord.t, t0: newChord.t }  // backward seek
                            : { ..._diagChord, t: newChord.t };                 // forward restrum
                    }
                }

                // Guard for backward seeks within the same chord (same key, no branch above).
                // If _diagPrevStartT is in the future relative to now, the crossfade was set up
                // during a later playback position that has since been seeked past. Clear it so
                // the stale outgoing diagram does not stay fully visible at the seek target.
                if (_diagPrev && _diagPrevStartT !== null && _diagPrevStartT > now) {
                    _diagPrev = null; _diagPrevOpacity = 0; _diagPrevStartOpacity = 0;
                    _diagPrevStartT = null;
                }

                // Entrance: derived from t0 (the original appearance time, not updated on
                // forward restrums) so repeated hits of the same chord do not replay the
                // 0.85→1.0 scale animation. On backward seeks t0 is updated alongside t,
                // so the animation still rewinds correctly to the earlier position.
                const _entranceAnchor = _diagChord && (_diagChord.t0 ?? _diagChord.t);
                _diagEntranceT = (_diagChord && _entranceAnchor !== undefined)
                    ? Math.min(1.0, Math.max(0, (now - _entranceAnchor) / DIAG_ENTRANCE_S))
                    : 1.0;

                // Crossfade: derived from absolute start time so backward seeks within the
                // crossfade window correctly rewind the fade. _diagPrev is kept alive (at
                // opacity 0) until the next key change rather than destroyed here, so that a
                // backward seek that re-enters the crossfade window can recompute a positive
                // opacity. Seeks before _diagPrevStartT are handled by the guard above.
                if (_diagPrev && _diagPrevStartT !== null) {
                    const fadedT = Math.max(0, now - _diagPrevStartT);
                    _diagPrevOpacity = Math.max(0, _diagPrevStartOpacity * (1 - fadedT / DIAG_CROSSFADE_S));
                }
            }
        }

        /**
         * Indexed sustain ribbon (~SLIDE_RIBBON_SAMPLES longitudinal slices)
         * for slides, bends, vibrato and tremolo — smooth contour vs stacked
         * BoxGeometry segments.
         */
        function slideRibbonUpdatePositions(geom, strandBaseX, tw, th, y, sliceDur, susStart, now, n, slideSt) {
            const pa = geom.attributes.position.array;
            const S = SLIDE_RIBBON_SAMPLES;
            // slideOffsetWorldX is defined at module scope so it returns a
            // right-handed delta (built from non-lefty fretMid). strandBaseX is
            // already lefty-mirrored via xFretMid at the call site, so the
            // delta needs the same sign flip to keep the slide tracking the
            // mirrored fretboard direction.
            const dirMul = _leftyCached ? -1 : 1;
            let v = 0;
            for (let k = 0; k <= S; k++) {
                const Tk = susStart + (k / S) * sliceDur;
                const zk = dZ(Tk - now);
                const xc = strandBaseX
                    + dirMul * slideOffsetWorldX(n, Tk, slideSt)
                    + tremoloOffsetWorldX(n, Tk, tw);
                const yc = y + techniqueYOffsetWorld(n, Tk);
                pa[v++] = xc - tw * 0.5; pa[v++] = yc - th * 0.5; pa[v++] = zk;
                pa[v++] = xc + tw * 0.5; pa[v++] = yc - th * 0.5; pa[v++] = zk;
                pa[v++] = xc + tw * 0.5; pa[v++] = yc + th * 0.5; pa[v++] = zk;
                pa[v++] = xc - tw * 0.5; pa[v++] = yc + th * 0.5; pa[v++] = zk;
            }
            geom.attributes.position.needsUpdate = true;
            // Normals are pre-baked at geometry creation (see mkSlideRibbonGeo);
            // axis-aligned cross-section means they don't need per-frame recompute.
        }

        function noteHasVibrato(n) {
            return !!(n && (n.vb || n.vibrato));
        }

        function bendVisualDirY(stringIdx) {
            if (!Number.isFinite(stringIdx) || nStr <= 1) return 1;
            const visualIdx = _invertedCached ? stringIdx : (nStr - 1 - stringIdx);
            return visualIdx >= (nStr - 1) * 0.5 ? -1 : 1;
        }

        function bendSemisAtTime(n, chartTime) {
            const bn = Number(n?.bn) || 0;
            if (!(bn > 0) || !(n?.sus > 0)) return 0;
            const p = Math.max(0, Math.min(1, (chartTime - n.t) / Math.max(n.sus, 1e-6)));
            // rise → hold → release: ramp up over the first ~35 %, hold, then
            // release back down over the last ~30 %. Depicts the bend gesture
            // (up and back down) rather than a monotone climb that only ever
            // showed the bend going up. Drives both the sustain ribbon's Y
            // contour and the gem's techniqueYNow offset.
            const RISE = BEND_ENV_RISE_FRAC, REL = BEND_ENV_RELEASE_FRAC;
            let env;
            if (p < RISE) env = p / RISE;
            else if (p < 1 - REL) env = 1;
            else env = (1 - p) / REL;
            return bn * Math.max(0, Math.min(1, env));
        }

        function vibratoSemisAtTime(n, chartTime) {
            if (!noteHasVibrato(n) || !(n?.sus > 0)) return 0;
            const elapsed = Math.max(0, chartTime - n.t);
            return Math.sin(elapsed * Math.PI / VIBRATO_HALF_WAVE_S);
        }

        function techniqueYOffsetWorld(n, chartTime) {
            if (!(n?.sus > 0)) return 0;
            const bendSemi = bendSemisAtTime(n, chartTime);
            const vibratoSemi = vibratoSemisAtTime(n, chartTime);
            if (bendSemi === 0 && vibratoSemi === 0) return 0;
            return bendVisualDirY(n.s) * BEND_HALFSTEP_WORLD_Y * (bendSemi + vibratoSemi);
        }

        function tremoloOffsetWorldX(n, chartTime, trailW) {
            if (!(n?.tr) || !(n?.sus > 0)) return 0;
            const elapsed = Math.max(0, chartTime - n.t);
            const phase = (elapsed % TREMOLO_BUMP_S) / TREMOLO_BUMP_S;
            const tri = (Math.abs(phase - 0.5) - 0.25) * 3;
            return trailW * 0.5 * tri;
        }

        /* ── Note renderer ───────────────────────────────────────────────── */
        // Rocksmith <chordTemplates> frets: -1 = unused, 0 = open, n>0 = fret.
        // Ghost digit for chord notes uses the template row when present so it
        // matches the XML diagram, not a divergent chordNote.f if any.
        function _templateFretForChordGhost(chordId, stringIdx, noteFret) {
            if (chordId == null) return noteFret;
            // Coerce: some upstream paths (e.g. hs.chord_id from sloppaks)
            // hand us string ids like "12". Cf. `templates[cid] ?? templates[Number(cid)]`
            // earlier in this file.
            const cid = typeof chordId === 'number' ? chordId : Number(chordId);
            if (!Number.isFinite(cid)) return noteFret;
            const fr = _drawChordTemplates?.[cid]?.frets;
            if (!Array.isArray(fr) || stringIdx < 0 || stringIdx >= fr.length) return noteFret;
            const tf = fr[stringIdx];
            if (typeof tf !== 'number' || tf < 0) return noteFret;
            return tf;
        }
        // skipLabel: don't draw per-note connector label (repeated fret)
        // skipBody:  don't draw the 3D note mesh (repeat chord — still shows projection)
        function drawNote(n, now, openX, skipLabel, skipBody, linger = 0.05, openChordBoxWidth, fromChord = false, chordId, susTrailMatchArpFrame = false) {
            const s = n.s;
            // Belt + suspenders: callers already gate via validString(),
            // but drawNote is also entered through { ...cn } chord-note
            // spreads, so re-check here before indexing material arrays.
            if (!validString(s)) return;
            const nxFrame = _drawNextByString && _drawNextByString[s];
            const dt = n.t - now;
            const ghostHold = fromChord ? linger : GHOST_HOLD_AFTER_ONSET;
            const nextTAligned = nxFrame != null && Math.abs(nxFrame.t - n.t) < NEXT_ON_STRING_T_EPS;
            const ghostPastHold = dt <= 0 && dt > -ghostHold
                && (nxFrame == null || nxFrame.t > n.t - 1e-6);
            const isNextOnString = nextTAligned || ghostPastHold;
            const y = sY(s);
            const susEnd = n.t + (n.sus || 0);
            const hasSus = n.sus > 0;
            // Smart cull past the normal ~50 ms linger: keep the gem alive
            // only if a note-state verdict is actually available to display
            // (so pre-verdict trailing gems don't read as "stuck unjudged"
            // sliver). With a verdict the gem stays up to
            // NOTEDETECT_GEM_VERDICT_WINDOW for the green/red border to read.
            // The probe result is cached in _ndProbed/_ndProbedState so the
            // later _ndGetNoteState query that drives the outline/core tint
            // reuses it (avoids two provider calls per note per frame).
            let _ndProbed = false;
            let _ndProbedState = null;
            if (dt < -linger && (!hasSus || now > susEnd)) {
                if (!_ndHasProvider || dt < -NOTEDETECT_GEM_VERDICT_WINDOW) return;
                let _ndProbe = null;
                try { _ndProbe = _ndGetNoteState(n, n.t); } catch (e) { _ndProbe = null; }
                _ndProbed = true;
                _ndProbedState = _ndProbe;
                const _probeSt = (_ndProbe && typeof _ndProbe === 'object') ? _ndProbe.state : _ndProbe;
                if (_probeSt !== 'hit' && _probeSt !== 'active' && _probeSt !== 'miss') return;
            }

            const sustained = dt < 0 && hasSus && now <= susEnd;
            const hitDist = Math.abs(dt);
            const hit = hitDist < 0.15 || sustained;
            const hitFade = sustained ? 0.7 : (hitDist < 0.15 ? 1 - hitDist / 0.15 : 0);
            const hasTechniqueVibrato = noteHasVibrato(n);
            const techniqueYNow = sustained ? techniqueYOffsetWorld(n, now) : 0;
            const noteZ = sustained ? 0 : Math.min(0, dZ(dt));
            const x = n.f === 0 ? (openX !== undefined ? openX : curX) : xFretMid(n.f);
            const isHarm = n.hm || n.hp;

            // Open chord notes: wide default mesh is capped to chord frame width.
            const OPEN_NOTE_WORLD_W = 40 * K;
            let openWScale = 1;
            if (n.f === 0 && openChordBoxWidth != null && openChordBoxWidth > 1e-8) {
                openWScale = Math.max(0.22, (openChordBoxWidth * 0.96) / OPEN_NOTE_WORLD_W);
            }

            // Hoisted so both !skipBody blocks (gem and technique labels) and
            // the unconditional sustain trail all share one declaration.
            // For skipBody=true (slide targets), defaults are safe no-ops.
            const openSlabThickMul = n.f === 0 ? 1.5 : 1;
            const approachRot = n.f > 0 ? Math.max(0, Math.min(1, dt / AHEAD)) * Math.PI / 2 : 0;
            const PROJ_WIN_G = 0.6;
            const projFactorG = Math.max(0, Math.min(1, 1 - Math.max(dt, 0) / PROJ_WIN_G));
            const inGhostWin = n.f > 0 && isNextOnString && dt > -ghostHold && dt < PROJ_WIN_G && projFactorG > 0.001;
            // slopsmith#254 — query the provider once per note, before both !skipBody
            // blocks, so _showHit can be a const and _ndGood is available for the
            // sustain trail (which renders even when skipBody=true for slide targets).
            let _ndGood = false;    // true when provider confirms hit/active
            let _ndState = null;    // 'hit'|'active'|'miss'|null; null → fall back to proximity heuristic
            let _ndCs = null;       // raw provider response kept for alpha/color in _ndSizzle
            let _ndCsIsObj = false; // typeof _ndCs === 'object'
            if (_ndGetNoteState) {
                // Reuse the smart-cull probe result if we already called
                // _ndGetNoteState for this gem above; otherwise probe now.
                let _raw = null;
                if (_ndProbed) {
                    _raw = _ndProbedState;
                } else {
                    try { _raw = _ndGetNoteState(n, n.t); } catch (e) { _raw = null; }
                }
                if (_raw) {
                    _ndCsIsObj = typeof _raw === 'object';
                    const _st = _ndCsIsObj ? _raw.state : _raw;
                    if (_st === 'miss') {
                        _ndState = 'miss';
                        _ndCs = _raw;
                    } else if (_st === 'hit' || _st === 'active') {
                        _ndState = _st;
                        _ndGood = true;
                        _ndCs = _raw;
                    }
                }
            }
            // Provider verdict wins when present; otherwise fall back to the
            // proximity heuristic, including the pre-hit ghost window preview.
            const _showHit = (_ndState === 'miss') ? false : (_ndState ? _ndGood : (hit || (n.f > 0 && inGhostWin)));

            if (!skipBody) {

                // ── Outline (slightly larger, bright emissive) ────────────
                // Notedetect feedback (#9): if a recent hit/miss event
                // matches this note's (s, f, t), swap the outline tint.
                // Linear scan over a small bounded array — typical
                // queues are 0-5 entries, expired marks pruned by the
                // listener. Hit takes precedence over miss so the user
                // sees the more positive feedback if both happen
                // (shouldn't, but cheap guard).
                let _ndOutline = (n.f > 0 && mStrHitOutline[s]) ? mStrHitOutline[s] : mWhiteOutline;
                // update() prunes expired marks once per frame and
                // caches performance.now() in _ndFrameNowMs so the hot
                // path here just does the bounded match — no extra
                // now() / filter() per note. After update()'s prune,
                // every entry in the arrays has expiresAt > _ndFrameNowMs,
                // so we don't re-validate inside the loop.
                let _ndMatchedMark = null;
                let _ndHadHitMark = false;
                if (_ndHitMarks.length) {
                    for (let i = 0; i < _ndHitMarks.length; i++) {
                        const m = _ndHitMarks[i];
                        if (m.s === n.s && m.f === n.f && Math.abs(m.noteTime - n.t) < _ND_TIME_EPS) {
                            _ndOutline = mHitOutline; _ndMatchedMark = m; _ndHadHitMark = true; break;
                        }
                    }
                }
                if (!_ndHadHitMark && _ndMissMarks.length) {
                    for (let i = 0; i < _ndMissMarks.length; i++) {
                        const m = _ndMissMarks[i];
                        if (m.s === n.s && m.f === n.f && Math.abs(m.noteTime - n.t) < _ND_TIME_EPS) {
                            _ndOutline = mMissOutline; _ndMatchedMark = m; break;
                        }
                    }
                }
                if (_ndMatchedMark && _ndMatchedMark.labels && _ndMatchedMark.labels.length) {
                    _ndLabels.push({
                        x,
                        y: y + NH * 1.7,
                        z: noteZ + 0.02,
                        labels: _ndMatchedMark.labels,
                    });
                }
                // (approachRot / PROJ_WIN_G / projFactorG / inGhostWin hoisted above)

                const rimXY = n.ac ? ACCENT_RIM_XY_SCALE_MUL : 1;
                const rimZ = n.ac ? ACCENT_RIM_Z_SCALE_MUL : 1;

                // slopsmith#254 — apply visual overrides from the provider verdict
                // (_ndState/_ndGood/_ndCs computed in the hoisted block above).
                // 'miss' → red outline; 'hit'/'active' → green outline + sizzle.
                // A string-tinted outline (the old behaviour) was hard to read
                // as a verdict — it looked the same as an un-judged note on
                // that string. A dedicated green border (mHitOutline) reads
                // unambiguously against the red miss border.
                // The authoritative _showHit (body brightness, sustain glow) is
                // already a const from the hoisted block — no reassignment needed here.
                if (_ndCs) {
                    if (_ndState === 'miss') {
                        _ndOutline = mMissOutline;
                    } else if (_ndGood) {
                        _ndOutline = mHitOutline;
                        // Carry the provider's alpha (and optional color) through
                        // to the sizzle so a struck-note fade or custom palette
                        // comes through (#254 review).
                        // Skip sizzle on chord constituents — per-note sparkles
                        // on every chord note at lenient scoring rates became a
                        // measurable framerate hit; standalone notes still sparkle.
                        if (!fromChord && _ndSizzle.length < 40) {
                            const _a = (_ndCsIsObj && Number.isFinite(_ndCs.alpha)) ? Math.max(0, Math.min(1, _ndCs.alpha)) : 1;
                            const _col = (_ndCsIsObj && typeof _ndCs.color === 'string') ? _ndCs.color : null;
                            _ndSizzle.push({ x, y: y + techniqueYNow, z: noteZ, s, alpha: _a, color: _col });
                        }
                    }
                }

                // Accent: soft neon outer glow (reference: diffused halo fading out).
                // Three additive shells drawn behind outline/core; colour = string hue.
                // Suppressed on a provider miss verdict — a bright accent halo
                // around a missed gem muddies the dark-core-plus-red-rim fail
                // signal, matching the same miss-over-accent priority the
                // gem core material applies below.
                if (n.ac && _ndState !== 'miss' && mAccentHaloNear[s]) {
                    const rZ = approachRot;
                    const accentShells = [
                        { mat: mAccentHaloFar[s], ixy: ACCENT_HALO_XY_OUTER, iz: ACCENT_HALO_Z_OUTER, zK: 0.012 },
                        { mat: mAccentHaloMid[s], ixy: ACCENT_HALO_XY_MID, iz: ACCENT_HALO_Z_MID, zK: 0.008 },
                        { mat: mAccentHaloNear[s], ixy: ACCENT_HALO_XY_INNER, iz: ACCENT_HALO_Z_INNER, zK: 0.005 },
                    ];
                    for (let hi = 0; hi < accentShells.length; hi++) {
                        const sh = accentShells[hi];
                        const glow = pAccentHalo.get();
                        glow.material = sh.mat;
                        glow.rotation.z = rZ;
                        glow.position.set(x, y + techniqueYNow, noteZ - sh.zK * K);
                        if (n.f === 0) {
                            // Inside a chord/arpeggio frame: bloom only vertically so the
                            // halo doesn't burst past the chord box edges horizontally.
                            // Outside a frame: modest horizontal cap (1.4×) so it doesn't
                            // overflow into adjacent lane visuals.
                            const openIxy = fromChord ? 1.0 : Math.min(sh.ixy, 1.4);
                            const slabPuff = Math.max(1.4, sh.ixy);
                            glow.scale.set(
                                (40 * K / NW) * rimXY * openIxy * openWScale,
                                0.1 * openSlabThickMul * slabPuff,
                                0.6 * rimZ * sh.iz,
                            );
                        } else {
                            glow.scale.set(rimXY * sh.ixy, rimXY * sh.ixy, 2.5 * rimZ * sh.iz);
                        }
                    }
                }
                const outline = pNote.get();
                outline.material = (_ndMatchedMark != null || _ndState != null) ? _ndOutline
                    : (n.ac ? mAccentOutline[s] : _ndOutline);
                outline.renderOrder = 20;
                outline.position.set(x, y + techniqueYNow, noteZ);
                outline.rotation.z = approachRot;
                // slopsmith#254 — a provider hit/miss verdict gets a fatter
                // outline shell so the green / red border reads clearly as a
                // ring around the gem. The default 1.1x rim is a hairline on
                // small fretted gems (it only showed up on the wide open-note
                // slabs), so a verdict bumps it to 1.5x.
                const ndRim = (_ndState === 'miss' || _ndGood) ? 1.5 : 1.1;
                if (n.f === 0) {
                    outline.scale.set(
                        (35 * K / NW) * ndRim * rimXY * openWScale,
                        0.1 * ndRim * openSlabThickMul,
                        0.6 * ndRim * rimZ,
                    );
                } else {
                    outline.scale.set(ndRim * rimXY, ndRim * rimXY, 2.8 * rimZ);
                }

                // ── Core (filled note body) ───────────────────────────────
                const core = pNote.get();
                // slopsmith#254 — on a provider miss verdict, paint the gem
                // core a dark charcoal (mMissCore) and let the red rim
                // dominate, so the fail reads as an "extinguished" gem
                // regardless of which string's natural color it sits on
                // (a red rim on a red string disappears otherwise). Hits
                // grab attention with bright mGlow + sizzle; misses get a
                // distinct dark-with-red-rim look — clear without needing
                // a string-color contrast that doesn't exist for every lane.
                // A miss takes priority over the accent (`n.ac`) override —
                // a missed accented note is still a miss; without this
                // reordering the brighter mAccentCore would mask the fail
                // signal on every accent.
                core.material = (_ndState === 'miss') ? mMissCore
                    : (n.ac ? mAccentCore[s]
                        : (_showHit ? mGlow[s] : mStr[s]));
                core.renderOrder = 21;
                core.position.set(x, y + techniqueYNow, noteZ + 0.001);
                core.rotation.z = approachRot;
                if (n.f === 0) {
                    core.scale.set(
                        (40 * K / NW) * rimXY * openWScale,
                        0.1 * openSlabThickMul,
                        0.6 * rimZ,
                    );
                } else {
                    core.scale.set(rimXY, rimXY, 2.5 * rimZ);
                }
                // Fret digits on fretted (n.f > 0) flying notes deliberately
                // omitted: the showFretOnNote setting and its UI helper text
                // promise digits on the fretboard ghost only, never on the
                // gems coming down the highway. The ghost path is at
                // pGhostFretLbl below.
            } // end gem block — technique labels reopen !skipBody below

            // ── Sustain trail ─────────────────────────────────────────────
            // Rendered for ALL notes with sustain, including skipBody=true
            // slide-target notes (e.g. linkNext hold→slide: gem suppressed,
            // slide trail stays visible as the continuation of the sustain).
            // _ndGetNoteState is queried for every note (skipBody slide
            // targets included), so the trail picks bright mGlow[s] when the
            // provider confirms hit/active and dim mSus[s] otherwise — a
            // slide-target trail is not forced dim.
            // Chord-member open strings (fromChord && f === 0) skip the
            // sustain trail entirely — fretted constituents already carry
            // the chord's sustains; an extra ribbon under the wide open
            // body looked like clutter. The note BODY still draws above.
            if (hasSus && !(fromChord && n.f === 0)) {
                    const susStart = Math.max(n.t, now);
                    const remSus = susEnd - susStart;
                    if (remSus > 0.01) {
                        const sliceDur = Math.min(remSus, AHEAD);
                        let tw = NW * 0.85 * (n.f === 0 ? openWScale : 1);
                        let th = NH * 0.12 * (n.f === 0 ? openWScale : 1) * openSlabThickMul;
                        if (susTrailMatchArpFrame) {
                            const yA = sY(0), yB = sY(nStr - 1);
                            const yMinF = Math.min(yA, yB) - S_GAP * 0.8;
                            const yMaxF = Math.max(yA, yB) + S_GAP * 0.8;
                            const fullChordBoxH = yMaxF - yMinF;
                            const ft = Math.max(CHORD_FRAME_RIM_MIN * K, fullChordBoxH * CHORD_FRAME_RIM_FRAC_H);
                            const ftSide = ft * 1.55;
                            if (n.f > 0) {
                                th = ftSide;
                            } else {
                                th = Math.max(th, ftSide * openSlabThickMul);
                            }
                            tw = Math.max(tw, ftSide * 1.05);
                        }
                        // Standalone open strings get two parallel trails
                        // offset along X — visually echoes the wide flat
                        // open-note body. Fretted notes keep the
                        // single-trail path. Offsets are scaled by
                        // `openWScale` (the same body-width scale
                        // computed at line 7367) so the trails stay
                        // underneath the body's edges no matter how wide
                        // the anchor lane is. Chord-member open strings
                        // can't reach here (guarded at the `hasSus`
                        // check above).
                        //
                        // openTrailOff is always > 0 because openWScale
                        // is clamped >= 0.22 at line 7368 (or defaults
                        // to 1 when there's no openChordBoxWidth), so
                        // openTrailOff >= NW * 3 * 0.22 = 3.3 * K.
                        // No degenerate-small-offset fallback needed.
                        const offsets = (n.f === 0)
                            ? [-(NW * 3 * openWScale), NW * 3 * openWScale]
                            : SINGLE_SUS_OFFSETS;
                        const slideSt = slideTrailEnd(n);
                        const ribbonSusTrail = !!(
                            (slideSt && n.f > 0 && (n.sus || 0) > 1e-4)
                            || (Number(n.bn) > 0)
                            || n.tr
                            || hasTechniqueVibrato
                        );
                        const emitSusStrip = (xCenter, segLen, zCenter) => {
                            for (let i = 0; i < offsets.length; i++) {
                                const xOff = xCenter + offsets[i];
                                const trOut = pSusOutline.get();
                                trOut.renderOrder = 18;
                                trOut.position.set(xOff, y, zCenter);
                                trOut.scale.set(tw + 0.4 * K, th + 0.4 * K, segLen);
                                const tr = pSus.get();
                                // slopsmith#254 — a sustain currently being
                                // held correctly glows bright (mGlow), else
                                // the usual dim sustain material.
                                tr.material = _ndGood ? mGlow[s] : mSus[s];
                                tr.renderOrder = 19;
                                tr.position.set(xOff, y, zCenter);
                                tr.scale.set(tw, th, segLen);
                            }
                        };
                        if (!ribbonSusTrail) {
                            const len = sliceDur * TS;
                            const zPos = dZ(susStart - now) - len / 2;
                            emitSusStrip(x, len, zPos);
                        } else {
                            for (let si = 0; si < offsets.length; si++) {
                                const strandX = x + offsets[si];
                                const olMesh = pSusRibbonOl.get();
                                olMesh.renderOrder = 18;
                                olMesh.scale.set(1, 1, 1);
                                olMesh.rotation.set(0, 0, 0);
                                olMesh.position.set(0, 0, 0);
                                olMesh.material = mSusOutline;
                                slideRibbonUpdatePositions(
                                    olMesh.geometry, strandX,
                                    tw + 0.4 * K, th + 0.4 * K,
                                    y, sliceDur, susStart, now, n, slideSt,
                                );
                                const body = pSusRibbon.get();
                                body.renderOrder = 19;
                                body.scale.set(1, 1, 1);
                                body.rotation.set(0, 0, 0);
                                body.position.set(0, 0, 0);
                                body.material = _ndGood ? mGlow[s] : mSus[s];
                                slideRibbonUpdatePositions(
                                    body.geometry, strandX, tw, th, y,
                                    sliceDur, susStart, now, n, slideSt,
                                );
                            }
                        }
                    }
            }

            if (!skipBody) {
                // ── Technique labels ──────────────────────────────────────
                // Label scale = base × LBL_MULT × distFactor.
                // distFactor compensates for perspective shrink so a
                // label far from the camera (note approaching at dt≈AHEAD)
                // doesn't collapse to a single dim pixel. LBL_MULT bumps
                // every base scale uniformly. Issues #21-25 track proper
                // visual upgrades (3D arrows, ribbons, glows); this is
                // the cheap legibility win in the meantime.
                //
                // Offsets scale with sLbl too. The labels grow in world
                // units to compensate for perspective; if the offsets
                // didn't grow, stacked labels would overlap each other
                // and the first label would overlap the note at the
                // AHEAD edge. In screen space the offset stays roughly
                // constant — labels appear anchored to the note even
                // though the world-space distance grows.
                const LBL_MULT = 1.6;
                const distFactor = 1 + Math.max(0, Math.min(1, dt / AHEAD)) * 1.5;
                // Fold the user's text-size multiplier into sLbl so technique
                // labels (bend, H/P/T arrows, tremolo) plus on-body markers
                // such as palm mute and the pinch-harmonic icon.
                // all scale alongside the rest (`ac` accent → brighter body via mGlow).
                const sLbl = LBL_MULT * distFactor * _textSizeMul;
                // txtMat(..., 'technique') disables depthTest; without a high
                // renderOrder the transparent note core (mStr) can still paint
                // afterward and hide H/P/T, PM X, bends, etc. Same contract as
                // fret-row labels (issue #35, CLAUDE pitfall #7 corollary).
                const TECH_RO = 1000;
                let yo = y + techniqueYNow + NH * 0.8 * sLbl;
                const specialMarkerScale = n.f === 0
                    ? NH * 1.5 * sLbl * openWScale
                    : NH * 1.5 * sLbl;
                if (n.bn > 0) {
                    // Bend chevron stack — PlaneGeometry mesh so it tilts with
                    // the gem (approachRot). Fixed world size so it perspective-
                    // shrinks naturally without distFactor compensation.
                    const steps = Math.max(1, Math.min(4, Math.round(n.bn)));
                    const bendSm = bendChevronMat(steps, activePalette[s] || 0xffffff);
                    const l = pTechPlane.get();
                    l.material = _spriteMat2MeshMat(l, bendSm);
                    const cs = NH * 2.4;
                    l.scale.set(cs, cs, 1);
                    l.position.set(x, y + techniqueYNow + NH * 1.1, noteZ + 0.005);
                    l.rotation.z = approachRot;
                    l.renderOrder = TECH_RO;
                    // Reserve stack space above the chevron.
                    yo = Math.max(yo, y + techniqueYNow + NH * 2.5);
                }
                if (n.ho || n.po || n.tp) {
                    if (n.ho || n.po) {
                        // Hammer-on / pull-off: ▲/▼ triangle — PlaneGeometry mesh
                        // so it tilts with the gem instead of billboarding.
                        const triSm = triMat(!!n.ho, activePalette[s] || 0xffffff);
                        const tri = pTechPlane.get();
                        tri.material = _spriteMat2MeshMat(tri, triSm);
                        tri.scale.set(NH * 1.8, NH * 1.60, 1);
                        tri.position.set(x, y + techniqueYNow, noteZ + 0.005);
                        tri.rotation.z = approachRot;
                        tri.renderOrder = TECH_RO;
                        // Reserve stack space above the triangle for stacked labels.
                        yo = Math.max(yo, y + techniqueYNow + NH * 1.0);
                    } else {
                        const chevron = pTapChevron.get();
                        const chevronScale = NH * 0.8 * sLbl;
                        chevron.position.set(x, y + techniqueYNow, noteZ + 1.1 * K);
                        chevron.rotation.z = approachRot;
                        chevron.scale.set(chevronScale, chevronScale, 1);
                        chevron.renderOrder = TECH_RO;
                    }
                }
                // Tremolo label ('~~~') removed — trail shape already conveys it visually.
                if (n.pm || n.mt) {
                    // Muted notes: on-body X overlay — PlaneGeometry mesh so it
                    // rotates with the gem (approachRot) instead of billboarding.
                    // Palm mute = black X / white border; fret-hand mute = inverse.
                    const fretHandMute = !!n.mt;
                    const muteSprite = fretHandMute
                        ? muteXMat('#ffffff', '#000000')
                        : muteXMat('#000000', '#ffffff');
                    const muteMark = pTechPlane.get();
                    muteMark.material = _spriteMat2MeshMat(muteMark, muteSprite);
                    muteMark.material.opacity = hit ? 1.0 : 0.8;
                    // Arms cover 62.5% of canvas (pad=outerW/√2 for square caps).
                    // Scale by 1/0.625 = 1.60 to map arm tips to gem corners.
                    const muteScaleX = n.f === 0
                        ? NW * 1.60 * openWScale
                        : NW * 1.60;
                    const muteScaleY = NH * 1.60;
                    muteMark.scale.set(muteScaleX, muteScaleY, 1);
                    muteMark.position.set(x, y + techniqueYNow, noteZ + 0.1 * K);
                    muteMark.rotation.z = approachRot;
                    muteMark.renderOrder = TECH_RO;
                }
                // hm / hp — PlaneGeometry overlay sized like the palm-mute X,
                // so the symbol only appears on the front face and matches
                // the palm-mute marker proportions.
                if (n.hm || n.hp) {
                    const harmSprite = n.hm ? naturalHarmonicMat() : pinchHarmonicMat(activePalette[s]);
                    const harmMark = pTechPlane.get();
                    harmMark.material = _spriteMat2MeshMat(harmMark, harmSprite);
                    harmMark.material.opacity = _showHit ? 1.0 : 0.85;
                    const harmScaleX = n.f === 0 ? NW * 1.90 * openWScale : NW * 1.90;
                    harmMark.scale.set(harmScaleX, NH * 2.0, 1);
                    harmMark.position.set(x, y + techniqueYNow, noteZ + 0.15 * K);
                    harmMark.rotation.z = approachRot;
                    harmMark.renderOrder = TECH_RO;
                }

                // ── Per-note fret connector label ─────────────────────────
                if (n.f > 0 && !skipLabel) {
                    const minStringY = Math.min(sY(0), sY(nStr - 1));
                    const labelY = minStringY - S_GAP * 0.8;
                    // fade out in the last 0.5 s so it doesn't overlap the fret-row label at Z=0
                    const alpha = Math.max(0, Math.min(1, dt / 0.5)) * Math.min(1, (AHEAD - dt) / (AHEAD * 0.4));

                    const fretLabel  = pNoteFretLabel.get();
                    const cachedMat  = txtMat(n.f, FRET_LABEL_GOLD_HEX, false, 'noteFret');
                    if (fretLabel.material.map !== cachedMat.map) {
                        fretLabel.material.map = cachedMat.map;
                        fretLabel.material.needsUpdate = true;
                    }
                    fretLabel.position.set(x, labelY, noteZ);
                    const flS = NH * 2.2 * _textSizeMul * fretLabelScaleForFret(n.f);
                    fretLabel.scale.set(flS, flS, 1);
                    fretLabel.material.opacity = alpha;

                    const line = pConnectorLine.get();
                    line.position.set(x, labelY, noteZ);
                    line.scale.set(1, y - labelY, 1);
                    line.material.opacity = alpha * 0.8;
                }
            }

            // ── Board ghost: filled rim at Z=0 (always drawn for isNext) ─
            const PROJ_WIN = 0.6;
            const projFactor = Math.max(0, Math.min(1, 1 - Math.max(dt, 0) / PROJ_WIN));
            // isBlocked suppresses the pre-impact ghost for sustains so it
            // doesn't peek out from under the incoming note body in the
            // last 150ms. Gate on dt > 0 so the post-hit linger window
            // (dt ≤ 0, still inside ghostHold) keeps showing the ghost
            // frame + digits — without the dt>0 gate, all post-hit
            // sustain frames silently suppress the ghost too.
            const isBlocked = dt > 0 && dt < 0.15 && n.sus > 0;
            if (n.f > 0 && isNextOnString && projectionVisible && dt > -ghostHold && dt < PROJ_WIN && projFactor > 0.001 && !isBlocked) {
                // Ghost stays at final "on the board" orientation — not the
                // incoming approachRot sweep — so it nests with the note at impact.
                const projRim = 0; // harmonic gems now land horizontal (no diamond offset)
                const proj = projMeshArr[s];
                // _vibrancyProjOp (0.15..0.5) is the vibrancy-scaled idle floor;
                // scale the whole opacity by (_vibrancyProjOp / 0.15) so the slider
                // affects the projection the same way it affects note bodies.
                const projScale = _vibrancyProjOp / 0.15;
                const bodyDim = skipBody ? 0.38 : 1;
                const rimSolid = 0.42 + projFactor * 0.52;
                proj.material.opacity = Math.min(0.96,
                    projScale * rimSolid * (0.5 + 0.5 * glowMul) * bodyDim);
                proj.material.emissiveIntensity = (0.07 + projFactor * 0.48) * glowMul * bodyDim;
                proj.position.set(x, y, 0);
                proj.scale.set(1, 1, 1);
                proj.rotation.z = projRim;
                proj.visible = true;

                const ghostFretOk = showFretOnNote && (
                    fretNumberGhostScope === 'all' ||
                    (fretNumberGhostScope === 'rocksmith' && fromChord)
                );
                if (ghostFretOk && pGhostFretLbl && _ghostLblBox && _ghostLblMid && _ghostLblTowardCam && cam) {
                    // Flat Mesh in the board XY plane (same as proj), not a Sprite billboard,
                    // so perspective + projRim match the 3D ghost frame.
                    const lb = pGhostFretLbl.get();
                    const ghostFretDisplay = fromChord
                        ? _templateFretForChordGhost(chordId, n.s, n.f)
                        : n.f;
                    const sprMat = txtMat(ghostFretDisplay, '#ffffff', false, 'noteFret');
                    const baseGhostMat = _meshMatForGhostFretDigit(sprMat);
                    let ghostFretLblAlpha = 1;
                    if (ghostPastHold) {
                        const nextSoon = nxFrame != null && nxFrame.t > n.t + 1e-6
                            && (nxFrame.t - now) <= GHOST_FRET_LBL_FADE_S;
                        const ghostFadeS = Math.min(GHOST_FRET_LBL_FADE_S, ghostHold);
                        ghostFretLblAlpha = hwyPostHitTailFadeMul(dt, ghostHold, nextSoon, ghostFadeS);
                    }
                    let instMat = lb.userData.h3dGhostFretLblInstMat;
                    if (!instMat || instMat.map !== baseGhostMat.map) {
                        if (instMat) {
                            try { instMat.dispose(); } catch (_) { /* idempotent */ }
                        }
                        // Set shader-defining state (transparent) once at clone
                        // time with needsUpdate; per-frame opacity updates after
                        // this don't need the recompile flag.
                        instMat = baseGhostMat.clone();
                        instMat.transparent = true;
                        instMat.needsUpdate = true;
                        lb.userData.h3dGhostFretLblInstMat = instMat;
                    }
                    instMat.opacity = ghostFretLblAlpha;
                    lb.material = instMat;
                    const ghostOuterL = Math.max(NW * 1.1, NH * 1.1);
                    // Scale by the *displayed* fret so chord-template ghosts
                    // (which may show a different fret than n.f) aren't sized
                    // for the wrong column.
                    const ghostLblS = 0.7 * ghostOuterL * _textSizeMul * fretLabelScaleForFret(ghostFretDisplay);
                    lb.scale.set(ghostLblS, ghostLblS, 1);
                    // Leaf mesh under stationary noteG — no need to recurse children
                    // (true forced a full subgraph walk each ghost label).
                    proj.updateMatrixWorld(false);
                    _ghostLblBox.setFromObject(proj);
                    _ghostLblBox.getCenter(_ghostLblMid);
                    _ghostLblTowardCam.subVectors(cam.position, _ghostLblMid);
                    const pull = _ghostLblTowardCam.length();
                    const eps = 1.6 * K;
                    if (pull > 1e-8) {
                        _ghostLblTowardCam.multiplyScalar(eps / pull);
                        lb.position.copy(_ghostLblMid).add(_ghostLblTowardCam);
                    } else {
                        lb.position.copy(_ghostLblMid);
                    }
                    lb.rotation.set(0, 0, projRim);
                }
            }
        }

        function drawNotedetectLabels(ctx, W, H) {
            if (!_ndLabels.length || !cam || !_probe) return;
            ctx.save();
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const item of _ndLabels) {
                _probe.set(item.x, item.y, item.z);
                _probe.project(cam);
                if (_probe.z < -1 || _probe.z > 1) continue;
                const sx = (_probe.x * 0.5 + 0.5) * W;
                const sy = (-_probe.y * 0.5 + 0.5) * H;
                for (let i = 0; i < item.labels.length; i++) {
                    const label = item.labels[i];
                    const y = sy + (i - (item.labels.length - 1) / 2) * 15;
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                    ctx.strokeText(label.text, sx, y);
                    ctx.fillStyle = label.color;
                    ctx.fillText(label.text, sx, y);
                }
            }
            ctx.restore();
        }

        // slopsmith#254 — the "sparkle/sizzle": a few tiny bright dots that
        // twinkle on each confirmed hit/active note, re-randomised every
        // frame, contained to roughly the note's footprint (no halo / no
        // shockwave / no long sparks). Drawn on the 2D overlay AFTER
        // ren.render(), positioned by projecting the note's world point
        // through the now-up-to-date camera so it sits exactly on the
        // note and follows it. _ndSizzle is filled by drawNote(); rebuilt
        // every frame, so the sparkle lives for exactly as long as the
        // provider keeps reporting hit/active for that note (and stops
        // the instant it goes away or a held sustain drops off-pitch).
        function drawNotedetectSizzle(ctx, W, H) {
            if (!_ndSizzle.length || !cam || !_probe) return;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineCap = 'round';
            for (const it of _ndSizzle) {
                _probe.set(it.x, it.y, it.z);
                _probe.project(cam);
                if (_probe.z < -1 || _probe.z > 1) continue;
                const cx = (_probe.x * 0.5 + 0.5) * W;
                const cy = (-_probe.y * 0.5 + 0.5) * H;
                // On-screen note size: project a point half a note-width to
                // the side along the fretboard X axis (reliably non-parallel
                // to the view direction, unlike a world-Y offset on a note
                // that's rotated flat at the strike line), and take the 2D
                // pixel distance. Floored so it always draws something.
                _probe.set(it.x + NW * 0.5, it.y, it.z);
                _probe.project(cam);
                const ex = (_probe.x * 0.5 + 0.5) * W, ey = (-_probe.y * 0.5 + 0.5) * H;
                const r = Math.max(8, Math.hypot(ex - cx, ey - cy));
                if (r > Math.min(W, H) * 0.4) continue;                 // absurd projection — skip
                // Provider-driven fade: scale opacity AND on-probability by
                // the entry's alpha so a struck-note glow visibly fades out
                // (more dots/arcs drop off as alpha decays), and prefer the
                // provider's custom color (when given) for the string-color
                // half of the mix. alpha defaults 1 (full intensity).
                const itA = (typeof it.alpha === 'number') ? it.alpha : 1;
                if (itA <= 0) continue;
                const c = activePalette[it.s];
                const colHex = (typeof it.color === 'string')
                    ? it.color
                    : ((typeof c === 'number')
                        ? '#' + ('000000' + (c >>> 0).toString(16)).slice(-6)
                        : '#ffffff');
                const rx = r * 1.08, ry = r * 0.66;                     // note is a flat wide rect at the line
                const skipBoost = 0.6 * (1 - itA);                      // extra "off" probability as alpha fades

                // Crackling edge — short bright arc segments flicking around
                // the note's perimeter, re-randomised each frame so the
                // outline "sizzles". Soft glow on each so it pops; still
                // contained right at the note's edge (≲1.4×).
                const arcs = 8;
                for (let i = 0; i < arcs; i++) {
                    if (Math.random() < 0.2 + skipBoost) continue;
                    const a0 = Math.random() * Math.PI * 2;
                    const a1 = a0 + (0.3 + Math.random() * 0.85);
                    const rr = 0.92 + Math.random() * 0.46;             // ≈0.92–1.38× the note edge
                    const white = Math.random() < 0.5;
                    ctx.globalAlpha = (0.55 + Math.random() * 0.45) * itA;
                    ctx.strokeStyle = white ? '#ffffff' : colHex;
                    ctx.shadowColor = white ? '#ffffff' : colHex;
                    ctx.shadowBlur = Math.max(3, r * 0.22) * itA;
                    ctx.lineWidth = Math.max(2, r * 0.2);
                    ctx.beginPath();
                    ctx.ellipse(cx, cy, rx * rr, ry * rr, 0, a0, a1);
                    ctx.stroke();
                }

                // Sparkle — bright dots twinkling on/around the note.
                const N = 16;
                for (let i = 0; i < N; i++) {
                    if (Math.random() < 0.28 + skipBoost) continue;     // twinkle — more off as alpha fades
                    const ang = Math.random() * Math.PI * 2;
                    const d = 0.12 + Math.random() * 1.05;              // 0.12–1.17× the edge
                    const dx = cx + Math.cos(ang) * rx * d;
                    const dy = cy + Math.sin(ang) * ry * d;
                    const white = Math.random() < 0.5;
                    ctx.globalAlpha = (0.6 + Math.random() * 0.4) * itA;
                    ctx.fillStyle = white ? '#ffffff' : colHex;
                    ctx.shadowColor = white ? '#ffffff' : colHex;
                    ctx.shadowBlur = Math.max(2, r * 0.16) * itA;
                    ctx.beginPath();
                    ctx.arc(dx, dy, 1.6 + Math.random() * Math.max(3.5, r * 0.22), 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.shadowBlur = 0;
            }
            ctx.restore();
        }

        /* ── Camera smooth lerp ──────────────────────────────────────────── */
        function camUpdate(bundle) {
            const bpm = computeBPM(bundle.beats, bundle.currentTime);
            const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
            curX += (tgtX - curX) * lerp;
            curDist += (tgtDist - curDist) * lerp;
            const dist = curDist * aspectScale;
            const h = CAM_H_BASE * (dist / CAM_DIST_BASE);
            const shoulderOffset = (_leftyCached ? -1 : 1) * 20 * K;
            cam.position.set(curX + shoulderOffset, h * 0.95, dist * 0.75);

            // Self-correcting look-at Y: project the fretboard's near-edge centre
            // to NDC space. If it drifts toward the frame edge, nudge tgtLookY
            // toward the fretboard centre so the camera tilts to re-frame it.
            // This lets the camera adapt to any panel aspect ratio automatically.
            const fretMidY = (sY(0) + sY(nStr - 1)) / 2;
            _probe.set(curX, fretMidY, 0);                  // play-line fretboard centre
            cam.lookAt(curX, curLookY, -FOCUS_D * 0.35);    // tentative look — needed for project()
            cam.updateMatrixWorld();
            _probe.project(cam);                             // _probe.y → NDC in [-1, 1]

            // Keep fretboard centre in the lower third of the screen (NDC ≈ -0.35).
            // The deadband width and correction strength are both blended
            // between Twitchy and Calm bounds by the user's tiltSmoothing
            // setting — twitchy = re-frame aggressively (narrow band, strong
            // nudge); calm = let small drift ride (wide band, weak nudge).
            const DESIRED_NDC_Y = -0.35;
            const tiltBand   = CAM_TILT_BAND_T + (CAM_TILT_BAND_C - CAM_TILT_BAND_T) * tiltSmoothing;
            const tiltStr    = CAM_TILT_STR_T  + (CAM_TILT_STR_C  - CAM_TILT_STR_T)  * tiltSmoothing;
            if (_probe.y < DESIRED_NDC_Y - tiltBand || _probe.y > DESIRED_NDC_Y + tiltBand) {
                // _probe.y too low → fretboard near bottom → tgtLookY decreases → camera tilts down → fretboard rises
                // _probe.y too high → fretboard near top  → tgtLookY increases → camera tilts up   → fretboard drops
                const correction = (DESIRED_NDC_Y - _probe.y) * fretMidY * tiltStr;
                tgtLookY = Math.max(-fretMidY, Math.min(fretMidY, tgtLookY - correction));
            }
            curLookY += (tgtLookY - curLookY) * lerp;

            // Final look-at with the corrected Y (overrides the tentative one above)
            cam.lookAt(curX, curLookY, -FOCUS_D * 0.35);
        }

        /* ── Resize helper ───────────────────────────────────────────────── */
        function _syncWrapControlsInset() {
            if (!wrap) return;
            const ch = document.getElementById('player-controls')?.offsetHeight || 0;
            wrap.style.bottom = ch > 0 ? ch + 'px' : '0';
        }

        function applySize(w, h) {
            if (!ren || !cam || !wrap) return;
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
            _syncWrapControlsInset();
            const baseDPR = _ssActive() ? Math.min(devicePixelRatio, 1.25) : Math.min(devicePixelRatio, 2);
            ren.setPixelRatio(_renderScale * baseDPR);
            ren.setSize(w, h);
            if (lyricsCanvas) { lyricsCanvas.width = w; lyricsCanvas.height = h; }
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
            aspectScale = Math.max(1, REF_ASPECT / Math.max(cam.aspect, 0.5));
        }

        /* ── Teardown ────────────────────────────────────────────────────── */
        function teardown() {
            // Background animations (#13). Drop the listener first so any
            // mid-teardown settings change doesn't try to rebuild a torn-
            // down scene; then dispose the active style's resources.
            if (_bgListener) { _bgUnsubscribe(_bgListener); _bgListener = null; }
            // Notedetect listeners (issue #9). Remove on destroy so a
            // panel that stops doesn't keep accumulating marks. Marks
            // arrays are cleared too — they hold stale chart positions
            // that next init() may reuse (drawNote keys on (s, f, t)).
            if (_ndOnHit) { window.removeEventListener('notedetect:hit', _ndOnHit); _ndOnHit = null; }
            if (_ndOnMiss) { window.removeEventListener('notedetect:miss', _ndOnMiss); _ndOnMiss = null; }
            if (window.slopsmith && typeof window.slopsmith.off === 'function') {
                if (_ndOnBusHit)  window.slopsmith.off('note:hit', _ndOnBusHit);
                if (_ndOnBusMiss) window.slopsmith.off('note:miss', _ndOnBusMiss);
                if (_visibilityHandler) {
                    try { window.slopsmith.off('highway:visibility', _visibilityHandler); } catch (e) {}
                }
                if (_canvasReplacedHandler) {
                    try { window.slopsmith.off('highway:canvas-replaced', _canvasReplacedHandler); } catch (e) {}
                }
            }
            _ndOnBusHit = _ndOnBusMiss = null;
            _visibilityHandler = null;
            _canvasReplacedHandler = null;
            _ndHitMarks = [];
            _ndMissMarks = [];
            _ndLabels = [];
            _ndSizzle = [];
            _chordVerdicts = new Map();
            _bgUnmountStyle();
            bgGroup = null; _bgLastT = 0;
            _diagChord = null; _diagPrev = null; _diagPrevOpacity = 0; _diagPrevStartOpacity = 0; _diagPrevStartT = null;
            _diagEntranceT = 1.0; _diagLastKey = null;

            if (wrap) { wrap.remove(); wrap = null; }
            _disposeOpenStringPitchSprites();
            if (scene) {
                // Don't dispose material.map textures here. Texture
                // lifetime belongs to whoever allocated it; the bg
                // styles' per-layer CanvasTextures (e.g. silhouettes'
                // wrappers around the shared _silCanvas) are released
                // in their own teardowns. txtCache textures are
                // explicitly disposed below; mStr/mGlow/etc. don't have
                // a .map. Disposing here would either double-free or
                // yank a still-in-use texture out from under another
                // mount.
                scene.traverse((obj) => {
                    obj.geometry?.dispose?.();
                    if (obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        for (const m of mats) m?.dispose?.();
                    }
                });
                // Shared chord-frame fill gradient — not owned by txtCache;
                // MeshBasicMaterial.dispose() does not release maps.
                chordFrameGradTex?.dispose?.();
                chordFrameGradTexArp?.dispose?.();
            }
            gNote?.dispose?.(); gSus?.dispose?.(); gBeat?.dispose?.(); gSusRail?.dispose?.(); gTapChevron?.dispose?.();
            mSusRailBase?.dispose?.(); mSusRailBase = null; gSusRail = null; pSusRail = null;
            gSusRailBloom?.dispose?.(); mSusRailBloomBase?.dispose?.(); _bloomGaussTex?.dispose?.();
            gSusRailBloom = null; mSusRailBloomBase = null; _bloomGaussTex = null; pSusRailBloom = null;
            gTechPlane?.dispose?.(); gTechPlane = null; pTechPlane = null;
            gChordAccentHalo?.dispose?.(); gChordAccentHalo = null;
            for (const m of mStr) m?.dispose?.();
            for (const m of mGlow) m?.dispose?.();
            for (const m of mSus) m?.dispose?.();
            for (const m of mStrHitOutline) m?.dispose?.();
            for (const m of mAccentOutline) m?.dispose?.();
            for (const m of mAccentCore) m?.dispose?.();
            for (const m of mAccentHaloNear) m?.dispose?.();
            for (const m of mAccentHaloMid) m?.dispose?.();
            for (const m of mAccentHaloFar) m?.dispose?.();
            mBeatM?.dispose?.(); mBeatQ?.dispose?.();
            // Notedetect outline materials (#9). May not be reachable
            // via scene.traverse if no event ever fired (never attached
            // to a mesh), so dispose explicitly.
            mHitOutline?.dispose?.(); mMissOutline?.dispose?.(); mMissCore?.dispose?.();
            for (const k in txtCache) {
                const tm = txtCache[k];
                tm.userData.h3dGhostFretMeshMat?.dispose?.();
                tm.userData.h3dGhostFretMeshMat = null;
                tm.userData.h3dTechMeshMat?.dispose?.();
                tm.userData.h3dTechMeshMat = null;
                tm.map?.dispose();
                tm.dispose();
            }
            // Technique-marker sprite materials (triMat / bendChevronMat) —
            // own numeric-keyed cache, not reachable via txtCache.
            for (const tm of _techMatCache.values()) {
                tm.map?.dispose();
                tm.dispose();
            }
            _techMatCache.clear();
            // Dispose per-sprite cloned materials (e.g. pmMark._pmMat).
            // These aren't reachable via scene.traverse once the sprite
            // gets reassigned a different material, so the array tracks
            // them at allocation time.
            for (const m of _ownedClonedMats) m?.dispose?.();
            _ownedClonedMats.length = 0;
            // Per-mesh technique-marker clones (from _spriteMat2MeshMat).
            // The Set tracks the live clone for each pool mesh; dispose all
            // on teardown so no GPU material leaks between init() cycles.
            for (const m of _techMeshMatClones) m?.dispose?.();
            _techMeshMatClones.clear();
            // Shared pool-factory materials/geometries (mLaneOdd/Even, etc.) —
            // see _ownedSharedMats comment near the declaration. Dispose is
            // idempotent so the scene.traverse() pass above won't double-free.
            for (const m of _ownedSharedMats) m?.dispose?.();
            _ownedSharedMats.length = 0;
            for (const g of _ownedSharedGeos) g?.dispose?.();
            _ownedSharedGeos.length = 0;
            txtCache = {};
            if (ren) { ren.dispose(); ren = null; }
            scene = cam = noteG = beatG = lblG = fretG = tuningLblG = null;
            ambLight = dirLight = null;
            mStr = []; mGlow = []; mSus = []; mStrHitOutline = []; mAccentOutline = []; mAccentCore = []; mAccentHaloNear = []; mAccentHaloMid = []; mAccentHaloFar = []; mWhiteOutline = mSusOutline = null; mHitOutline = mMissOutline = mMissCore = null; stringLines = []; stringLineGlows = [];
            for (const m of _inlayMats) m?.dispose?.(); _inlayMats = []; _inlayLabels = [];
            // mTapChevron: dispose explicitly — if no tap marker ever
            // spawned a pooled mesh, the scene.traverse() pass above never
            // reaches this material.
            mTapChevron?.dispose?.();
            mTapChevron = null;
            // mBarre is a shared material that all pBarreLine pool meshes
            // reference. If no barre chord ever appears, the pool factory
            // is never called, so no mesh carries mBarre into the scene
            // and scene.traverse() will miss it. Dispose explicitly here
            // to avoid leaking the GPU resource across panel lifecycles.
            // Three.js dispose() is idempotent, so calling it before or
            // after scene.traverse() is safe in both the instantiated and
            // uninstantiated cases.
            mBarre?.dispose?.(); mBarre = null;
            _paletteColorTmp = null;
            lyricsCanvas = lyricsCtx = null;
            projMeshArr = null;
            _probe = null;
            _ghostLblBox = _ghostLblMid = _ghostLblTowardCam = null;
            _drawNextByString = null;
            _drawChordTemplates = null;
            _laneTargetColor = null;
            _renderScale = 1;
            mBeatM = mBeatQ = null;
            pNote = pSus = pSusOutline = pSusRibbon = pSusRibbonOl = pLbl = pBeat = pSec = null;
            pFretLbl = pLane = pLaneDivider = pGhostFretLbl = pChordBox = pChordFrameFill = pChordLbl = pBarreLine = pNoteFretLabel = pConnectorLine = pDropLine = pTapChevron = pAccentHalo = pChordAccentHalo = pPMXFill = pFHXFill = null;
            if (gPMXFill) { gPMXFill.dispose(); gPMXFill = null; }
            if (gFHXFill) { gFHXFill.dispose(); gFHXFill = null; }
            mLaneOdd = mLaneEven = mLaneDivider = mLaneDividerArp = gLanePlane = gGhostFretPlane = null;
            chordFrameGradTex = chordFrameGradTexArp = null;
            pFretColMarker = null;
            _fretMarkerWaveCache.clear();
            gNote = gSus = gBeat = gTapChevron = null;
            tgtX = curX = xFretMid(CAM_LOCK_CENTER_FRET); tgtDist = curDist = CAM_DIST_BASE; tgtLookY = curLookY = 0; nStr = NSTR; _oobStringWarned = false;
            _lookaheadCamX = xFretMid(CAM_LOCK_CENTER_FRET);
            _lookaheadFretSpan = DEFAULT_LOOKAHEAD_FRET_SPAN;
            _lookaheadCamPrevNow = null;
            _lookaheadLowBonusU = 0;
            _lookaheadHiNeckLatch = false;
            prevLowFretBonus = 0;
            prevLockActive = false;
            _camSnapped = false;
            _camPreScanned = false;
            _songKey = null;
            _slideTargetSet = null;
            _slideTargetNotesRef = null;
            _slideTargetChordsRef = null;
        }

        function canvasSize(canvas) {
            const controls = document.getElementById('player-controls');
            const controlsHeight = controls ? controls.offsetHeight : 120;
            if (canvas) {
                const rect = canvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { w: rect.width, h: Math.max(100, rect.height) };
                }
                // Parent is often #player, which includes the controls bar — never
                // size the overlay to that full height or WebGL steals pointer events.
                if (canvas.parentNode) {
                    const pr = canvas.parentNode.getBoundingClientRect();
                    if (pr.width > 0 && pr.height > 0) {
                        return {
                            w: pr.width,
                            h: Math.max(100, pr.height - controlsHeight),
                        };
                    }
                }
            }
            return { w: innerWidth, h: Math.max(100, innerHeight - controlsHeight) };
        }

        /* ── setRenderer contract ────────────────────────────────────────── */
        return {
            // Tells highway.js this renderer needs a webgl2-capable canvas.
            // Browsers lock a <canvas> to the first context type acquired,
            // so when this renderer is installed mid-session highway.js
            // replaces the underlying <canvas> element so getContext('webgl2')
            // can succeed (see static/highway.js _replaceCanvas).
            contextType: 'webgl2',
            init(canvas, bundle) {
                _unsubscribeFocus();
                if (wrap || ren) {
                    teardown();
                }
                _destroyed = _isReady = false;
                _isFocused = true;
                const myToken = ++_initToken;
                highwayCanvas = canvas;
                _invertedCached = !!(bundle && bundle.inverted);
                _leftyCached = !!(bundle && bundle.lefty);
                _renderScale = (bundle && bundle.renderScale) || 1;

                if (_ssActive()) {
                    window.slopsmithSplitscreen.onFocusChange(_onFocusChange);
                    _focusSubscribed = true;
                }

                // Async-ready contract (slopsmith#36 readyPromise). Resolves
                // when Three.js loaded + scene initialised (_isReady = true).
                // Rejects on any async failure so highway.js can revert.
                let _resolveReady, _rejectReady;
                this.readyPromise = new Promise((res, rej) => {
                    _resolveReady = res;
                    _rejectReady = rej;
                });
                // Shared rejection for superseded init cycles (destroy() or a
                // newer init() started before this one completed). highway.js
                // ignores the rejection when the renderer is no longer active.
                const _rejectSuperseded = () => _rejectReady(new Error('superseded'));

                loadThree().then(() => {
                    if (_destroyed || _initToken !== myToken) {
                        _rejectSuperseded();
                        return;
                    }
                    try {
                        nStr = resolveStringCount(bundle);
                        _invertedForBoard = _invertedCached;
                        _leftyForBoard = _leftyCached;
                        if (!initScene()) { _unsubscribeFocus(); _rejectReady(new Error('initScene failed')); return; }
                        const sz = canvasSize(highwayCanvas);
                        // Mark ready before RAF so any resize(w,h) calls that arrive
                        // in the meantime (e.g. from sizeCanvases()) are applied directly.
                        _isReady = true;
                        _resolveReady();
                        _updateFocusState();
                        if (sz.w > 0 && sz.h > 0) {
                            applySize(sz.w, sz.h);
                        } else {
                            // Panel container not yet laid out (sizeCanvases() runs after
                            // initPanel() in the setup sequence). Retry each frame until
                            // the panelDiv has real dimensions.
                            (function retrySize() {
                                if (_destroyed || !_isReady) return;
                                const s = canvasSize(highwayCanvas);
                                if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                                else requestAnimationFrame(retrySize);
                            })();
                        }
                    } catch (e) {
                        console.error('[3D-Hwy] init .then() threw:', e);
                        _isReady = false;
                        _unsubscribeFocus(); teardown();
                        _rejectReady(e);
                    }
                }).catch(e => {
                    if (_initToken !== myToken || _destroyed) {
                        _rejectSuperseded();
                        return;
                    }
                    console.error('[3D-Hwy] Three.js unavailable:', e);
                    _unsubscribeFocus();
                    _rejectReady(e);
                });
            },

            draw(bundle) {
                if (!_isReady) return;
                _invertedCached = !!bundle.inverted;
                _leftyCached = !!bundle.lefty;
                const newNStr = resolveStringCount(bundle);
                const newScale = bundle.renderScale || 1;
                const leftyChanged = _leftyCached !== _leftyForBoard;
                if (_invertedCached !== _invertedForBoard || leftyChanged || newNStr !== nStr) {
                    if (newNStr !== nStr) _oobStringWarned = false;
                    if (leftyChanged) {
                        curX = -curX;
                        tgtX = -tgtX;
                    }
                    nStr = newNStr;
                    buildBoard();
                    _invertedForBoard = _invertedCached;
                    _leftyForBoard = _leftyCached;
                }
                if (newScale !== _renderScale) {
                    _renderScale = newScale;
                    const s = canvasSize(highwayCanvas);
                    if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                }
                // Auto-resize lyricsCanvas when the highway canvas changes size.
                // In splitscreen the hw.resize override resizes the canvas element
                // but does not call renderer.resize(), so we detect the change here.
                if (highwayCanvas && (highwayCanvas.width !== _lastHwW || highwayCanvas.height !== _lastHwH)) {
                    _lastHwW = highwayCanvas.width;
                    _lastHwH = highwayCanvas.height;
                    const s = canvasSize(highwayCanvas);
                    if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                }
                update(bundle);
                camUpdate(bundle);

                // Background animations (#13). Compute frame dt once,
                // read audio bands when reactivity is on, delegate to
                // the active style's update().
                if (bgGroup && bgStyleId !== 'off') {
                    const nowMs = performance.now();
                    const dt = _bgLastT === 0 ? 1 / 60 : Math.min(0.1, (nowMs - _bgLastT) / 1000);
                    _bgLastT = nowMs;
                    const bands = bgReactive ? _bgReadBands() : BG_ZERO_BANDS;
                    const style = BG_STYLES[bgStyleId];
                    if (style && bgState) {
                        try { style.update(bgState, bands, dt, nowMs / 1000); }
                        catch (e) { console.error('[3D-Hwy] bg update threw', bgStyleId, e); }
                    }
                }

                ren.render(scene, cam);
                if (lyricsCtx && lyricsCanvas) {
                    lyricsCtx.clearRect(0, 0, lyricsCanvas.width, lyricsCanvas.height);
                    // Capture the actual lyrics-banner bottom so drawChordDiagram
                    // can step down past every wrapped row, not just a 2-row estimate.
                    let lyricsBottom = 0;
                    if (bundle.lyricsVisible && bundle.lyrics?.length) {
                        lyricsBottom = drawLyrics(bundle.lyrics, bundle.currentTime, lyricsCtx, lyricsCanvas.width, lyricsCanvas.height) || 0;
                    }
                    drawNotedetectSizzle(lyricsCtx, lyricsCanvas.width, lyricsCanvas.height);
                    drawNotedetectLabels(lyricsCtx, lyricsCanvas.width, lyricsCanvas.height);
                    // Draw outgoing diagram first so the incoming diagram renders on top,
                    // making the entrance scale-in animation visible during crossfades.
                    if (_diagPrev && _diagPrevOpacity > 0) {
                        drawChordDiagram(lyricsCtx, {
                            name: _diagPrev.name, frets: _diagPrev.frets,
                            opacity: _diagPrevOpacity,
                            // Derive entranceT live from _diagPrev.t so a backward seek within
                            // the crossfade window rewinds the scale, not just the opacity.
                            entranceT: (_diagPrev.t !== undefined)
                                ? Math.min(1.0, Math.max(0, (bundle.currentTime - _diagPrev.t) / DIAG_ENTRANCE_S))
                                : 1.0,
                            canvasW: lyricsCanvas.width, canvasH: lyricsCanvas.height,
                            inverted: _invertedCached,
                            sizeSlider: chordDiagramSize, position: chordDiagramPosition,
                            nStr: _diagPrev.nStr ?? nStr,
                            lyricsBottom,
                        });
                    }
                    if (_diagChord) {
                        drawChordDiagram(lyricsCtx, {
                            name: _diagChord.name, frets: _diagChord.frets,
                            opacity: Math.max(0, 1 + (_diagChord.t - bundle.currentTime) / DIAG_LINGER_S),
                            entranceT: _diagEntranceT,
                            canvasW: lyricsCanvas.width, canvasH: lyricsCanvas.height,
                            inverted: _invertedCached,
                            sizeSlider: chordDiagramSize, position: chordDiagramPosition,
                            // Use the string count captured when this chord was first seen so that
                            // an arrangement switch mid-linger does not remap the overlay columns.
                            nStr: _diagChord.nStr ?? nStr,
                            lyricsBottom,
                        });
                    }
                    if (sectionHudVisible && bundle.sections && bundle.sections.length) {
                        drawSectionHud(lyricsCtx, {
                            sections: bundle.sections,
                            currentTime: bundle.currentTime,
                            canvasW: lyricsCanvas.width, canvasH: lyricsCanvas.height,
                            position: sectionHudPosition,
                            sizeSlider: sectionHudSize,
                            lyricsBottom,
                        });
                    }
                }
                // Draw-hook compatibility: fire hooks registered via
                // window.highway.addDrawHook() on our 2D overlay canvas
                // so overlay plugins (fretboard, chord-label HUDs, etc.)
                // continue to render when the 3D renderer is active.
                // The hooks expect a 2D context — lyricsCtx is exactly
                // that, positioned above the WebGL surface.
                if (lyricsCtx && lyricsCanvas &&
                        window.highway &&
                        typeof window.highway.fireDrawHooks === 'function') {
                    window.highway.fireDrawHooks(
                        lyricsCtx, lyricsCanvas.width, lyricsCanvas.height
                    );
                }
            },

            resize(w, h) {
                if (!_isReady) return;
                const s = canvasSize(highwayCanvas);
                applySize(s.w > 0 ? s.w : w, s.h > 0 ? s.h : h);
            },

            destroy() {
                _destroyed = true; _isReady = false; _diagChord = null; _diagPrev = null; _diagLastKey = null;
                _lastHwW = 0; _lastHwH = 0;
                _unsubscribeFocus(); teardown();
                highwayCanvas = null;
            },
        };
    }

    window.slopsmithViz_highway_3d = createFactory;
    window.slopsmithViz_highway_3d.panelControls = [
        {
            key: 'palette',
            label: 'Palette',
            type: 'select',
            default: BG_DEFAULTS.palette,
            // Derived from PALETTE_IDS so the descriptor stays in sync when a
            // palette is added/removed/renamed — PALETTES is the single
            // source of truth. Label uses PALETTE_LABELS where set, else the
            // capitalized id (matches the Default/Neon/Pastel names).
            options: PALETTE_IDS.map((id) => ({
                id,
                label: PALETTE_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1)),
            })),
        },
        {
            key: 'cameraSmoothing',
            label: 'Camera smoothing (X-pan)',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            default: BG_DEFAULTS.cameraSmoothing,
        },
        {
            key: 'cameraLockLow',
            label: 'Lock camera at frets 1-12',
            type: 'toggle',
            default: BG_DEFAULTS.cameraLockLow,
        },
        {
            key: 'cameraLockZoom',
            label: 'Locked zoom (In ↔ Out)',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            default: BG_DEFAULTS.cameraLockZoom,
        },
    ];
    // Static metadata exposed on the factory:
    //   panelControls      - optional, host-readable descriptors for a
    //                        curated per-panel control surface. Renderer
    //                        values still flow through _bgLoadSettings().
    //   contextType        - required canvas context type. highway.js
    //                        replaces the <canvas> element when the
    //                        requested type differs from the current one,
    //                        so this renderer can be installed mid-session
    //                        even if the canvas was previously bound to 2D.
    //   matchesArrangement - Auto-mode predicate. When the picker is on
    //                        "Auto", core installs the first registered
    //                        viz whose predicate returns truthy on the
    //                        current song_info. Lead/Rhythm/Bass/Guitar
    //                        arrangements route here; Keys arrangements
    //                        are matched by the piano plugin instead.
    //                        _canRun3D() in app.js still gates Auto from
    //                        picking us on machines without WebGL2.
    window.slopsmithViz_highway_3d.contextType = 'webgl2';
    // Canonical guitar arrangement names (server.py: _ALLOWED_ARRANGEMENT_NAMES)
    // are Lead / Rhythm / Bass / Combo. `guitar` is included as a safety
    // net for sources that use a generic name (older imports, third-party
    // sloppaks). Word boundaries (\b) keep us from accidentally matching
    // arrangements that merely contain these as substrings (e.g. a
    // "BasslineKeys" arrangement would otherwise match `bass`).
    window.slopsmithViz_highway_3d.matchesArrangement = function (songInfo) {
        const arr = (songInfo && songInfo.arrangement) || '';
        return /\b(?:lead|rhythm|bass|combo|guitar)\b/i.test(arr);
    };

    // No imperative register() call needed: slopsmith#272 introduced the
    // consolidated tour menu, which discovers this plugin's tour automatically
    // via /api/plugins (has_tour:true from plugin.json's tour field) and
    // gates relevance on whether highway_3d is the active viz. A register()
    // call with only injectTriggerInto was a no-op anyway since the new menu
    // owns trigger placement; for buildSteps / onStart / onComplete / a
    // custom screens override, register() is still the right hook.

})();
