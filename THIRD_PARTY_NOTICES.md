# Third-party notices

Songsterr Highway is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).
It bundles the following third-party software.

## Slopsmith — 3D Highway visualization (`highway_3d`)

- Files: `vendor/slopsmith/highway_3d/screen.js` (shipped as `dist/vendor/slopsmith/highway_3d.js`)
- Upstream: Slopsmith by the Slopsmith contributors (originally `github.com/byrongamatos/slopsmith`,
  later `github.com/slopsmith/slopsmith`). The copy used here comes from the public mirror
  [JayMan8-1/slopsmith](https://github.com/JayMan8-1/slopsmith), plugin `plugins/highway_3d`, version 3.18.0.
- License: GNU Affero General Public License v3.0 (`vendor/slopsmith/LICENSE`)
- Modifications: the file in `vendor/` is unmodified. At build time `scripts/build.mjs` replaces one line,
  the `THREE_URL` constant, so Three.js is loaded from the copy bundled inside the extension
  (`chrome.runtime.getURL('vendor/three/three.module.min.js')`) instead of Slopsmith's server path.

## Three.js r170

- Files: `node_modules/three/build/three.module.min.js` (shipped as `dist/vendor/three/three.module.min.js`)
- Upstream: [mrdoob/three.js](https://github.com/mrdoob/three.js), version 0.170.0
- License: MIT, Copyright © 2010-2024 three.js authors (`dist/vendor/three/LICENSE`)
