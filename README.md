# Slophighway

Free, open-source Chrome extension that draws a **3D note highway** for guitar and bass on top of
the tabs at [songsterr.com](https://www.songsterr.com), synced to the site's own playback.

Notes fly in from the horizon onto a fretboard, in the style of Rocksmith, with string colors and
technique markers: bends, slides, hammer-ons / pull-offs, tapping, palm mutes, fret-hand mutes,
natural and pinch harmonics, vibrato, tremolo picking, accents and chord frames. The 3D renderer is
the `highway_3d` visualization from [Slopsmith](#credits).

> Not affiliated with, endorsed by or connected to Songsterr, Ubisoft or Rocksmith.

## Install

1. Download `slophighway-vX.Y.Z.zip` from the
   [latest release](https://github.com/slophighwaydev/slophighway/releases/latest) and unzip it
   somewhere you'll keep it (Chrome loads the extension from that folder).
2. Open `chrome://extensions` and turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the unzipped folder, the one that contains `manifest.json`.
4. Open any tab on songsterr.com and press Play.

Works in Chrome and other Chromium browsers (Edge, Brave, Opera, Vivaldi) on any OS.

**Updating:** download the new zip, replace the contents of the same folder, then click the reload
icon on the extension's card in `chrome://extensions` and refresh the Songsterr tab.

## Features

**Highway**

- Synced to the site's player: play, pause, seek, speed changes and loops.
- Guitar and bass, any number of strings, with techniques, chords, sections and repeats.
- Light 2D view as an alternative, and as a fallback for machines without WebGL2.

**Tracks and tuning**

- Pick the arrangement from the dropdown, or press `1`–`9` to switch tracks on the fly
  (lead → rhythm → bass…). Switching is instant, without reloading the highway.
- A badge shows the track you're on and pops up when it changes.
- **E Std** converts any tuning (Drop D, Eb, Open G…) to E Standard frets. It may look odd, but it
  lets you play everything without retuning.
- Song title, artist and tuning in the top-right corner (with the original tuning when converted,
  and the capo).
- Follows you as you browse to other songs, no page reload needed.

**Layout**

- Dock the highway at the **top** or **bottom** of the page, or use a **floating** panel you can
  drag and resize. The site's controls stay reachable.
- **Clear** background mode: the page shows through the highway, and clicks pass through to it.
- **Full** (highway fills the window) and **Hide**.
- **Detach** opens the highway in its own window: put it on a second monitor or make it full screen
  (double-click). It has its own track picker, view, quality and E Std controls, and `Space` /
  `1`–`9` work there too. Close it to bring the highway back to the tab.
- Preferences are remembered.

**Performance**

- Quality presets: **High**, **Balanced** (default, 60 fps cap) and **Performance** (60 fps cap,
  lower resolution, no antialiasing). If it stutters, try Performance.

**Keyboard**

| Key | Action |
| --- | --- |
| `1`–`9` | Switch track |
| `Space` | Play / pause |
| Double-click (detached window) | Full screen |

## What it does (and doesn't)

- Reads the tab data **your browser already loaded** for the page you're on, plus the player's
  position, and draws the highway. Audio is the site's own.
- It does **not** download, export or save tabs, does not bypass any paid feature, and does not send
  data anywhere. The only permission it asks for is `storage`, for your preferences.

## Build from source

Requires Node.js 18 or newer.

```bash
npm install
npm run build
```

Then load the `dist/` folder with **Load unpacked** as above. For development, `npm run dev`
rebuilds on every change in `src/`, `public/` or `vendor/`; reload the extension in
`chrome://extensions` and refresh the tab afterwards.

## How it works

1. `src/inject/main.ts` runs in the page and captures the track JSON the site fetches from its CDN,
   plus the app store's live clock (`player.getPosition().cursor`, in ms), song timing
   (`part.current.progression` with per-beat `timestamps`, repeats already expanded) and current song.
2. `src/songsterr/rocksmith.ts` converts the tab's measures into a Rocksmith-like chart (seconds,
   string 0 = lowest string): repeats and alternate endings, ties, sustains, swing, grace notes,
   chords and technique flags. When the site's timing isn't available it computes the same
   timeline from tempo automations.
3. `src/overlay/host3d.ts` feeds that chart to the Slopsmith renderer every animation frame;
   `src/overlay/highway.ts` is the lightweight 2D view.

Converter accuracy was checked against the site's own note timestamps (Cowboys From Hell,
Eruption, Quebre as Correntes): at most 17 ms off, on a grace note, and exact elsewhere.

## Credits

- **[Slopsmith](https://github.com/JayMan8-1/slopsmith)**: the `highway_3d` renderer (AGPL-3.0).
  Shipped with a few build-time tweaks listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **[Three.js](https://threejs.org)** r170 (MIT).

## License

[GNU AGPL-3.0](LICENSE). Because the bundled Slopsmith renderer is AGPL-3.0, the whole extension is
distributed under the same license: you're free to use, study, change and share it, as long as
modified versions stay open under the AGPL too.
