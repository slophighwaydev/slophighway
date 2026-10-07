# Songsterr Highway

Free, open-source Chrome extension that draws a **Rocksmith-style 3D note highway** on top of
[Songsterr](https://www.songsterr.com), synced to Songsterr's own playback (synth or original audio).

Notes come from the horizon onto a fretboard, with the Rocksmith string colors and technique
markers: bends, slides, hammer-ons / pull-offs, tapping, palm mutes, fret-hand mutes, natural and
pinch harmonics, vibrato, tremolo picking, accents and chord frames. The 3D renderer is the
`highway_3d` visualization from [Slopsmith](#credits).

> Português: extensão gratuita e de código aberto que desenha uma note highway 3D no estilo do
> Rocksmith por cima do Songsterr, sincronizada com o player do próprio Songsterr. O áudio continua
> vindo do Songsterr; a extensão só desenha.

## What it does (and doesn't)

- Reads the tab data **your browser already loaded** for the Songsterr page you're on, and the
  player's position, and draws the highway.
- Audio is Songsterr's: synth, or original audio with Songsterr Plus.
- It does **not** download, export or save tabs, does not bypass Songsterr Plus, and does not talk to
  any server other than Songsterr's own CDN.
- Not affiliated with Songsterr, Ubisoft or Rocksmith.

## Install (from source)

```bash
npm install
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and select the `dist/` folder.
3. Open any Songsterr tab and press Play.

The panel at the bottom has: arrangement picker (defaults to the track you're viewing in Songsterr),
**3D / 2D (light)** view, **Full** (full-screen highway) and **Hide**. Drag the top edge to resize.
Preferences are remembered.

## Develop

```bash
npm run dev
```

Rebuilds on every change in `src/`, `public/` or `vendor/`; then reload the extension in
`chrome://extensions` and refresh the Songsterr tab.

## How it works

1. `src/inject/main.ts` (page context) captures the track JSON Songsterr fetches from its CDN and
   reads Songsterr's app store for the live clock (`player.getPosition().cursor`, in ms) and the
   song timing (`part.current.progression` + per-beat `timestamps`, with repeats already expanded).
2. `src/songsterr/rocksmith.ts` converts Songsterr measures into a Rocksmith-like chart (seconds,
   string 0 = lowest string): repeats and alternate endings, ties, sustains, swing, grace notes,
   chords and technique flags. When Songsterr's timing isn't available it computes the same timeline
   from tempo automations.
3. `src/overlay/host3d.ts` feeds that chart to the Slopsmith renderer every animation frame;
   `src/overlay/highway.ts` is a lightweight 2D fallback for machines without WebGL2.

Converter accuracy was checked against Songsterr's own note timestamps (Cowboys From Hell,
Eruption, Quebre as Correntes): at most 17 ms off, on a grace note, and exact elsewhere.

## Credits

- **[Slopsmith](https://github.com/JayMan8-1/slopsmith)** — the `highway_3d` renderer
  (AGPL-3.0). Used unmodified except for where it loads Three.js from; see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **[Three.js](https://threejs.org)** r170 (MIT).

## License

[GNU AGPL-3.0](LICENSE). Because the bundled Slopsmith renderer is AGPL-3.0, the whole extension is
distributed under the same license: you're free to use, study, change and share it, as long as
modified versions stay open under the AGPL too.
