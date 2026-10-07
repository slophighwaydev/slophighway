import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(root, "dist");
const entries = ["content", "inject", "background", "detached"];

for (const entry of entries) {
  const result = spawnSync("npx", ["vite", "build"], {
    cwd: root,
    env: { ...process.env, ENTRY: entry },
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const publicDir = resolve(root, "public");
if (existsSync(publicDir)) {
  mkdirSync(distDir, { recursive: true });
  cpSync(publicDir, distDir, { recursive: true });
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// Three.js r170 (MIT), loaded by the Slopsmith renderer via dynamic import().
copyFile(
  resolve(root, "node_modules/three/build/three.module.min.js"),
  resolve(distDir, "vendor/three/three.module.min.js"),
);
copyFile(resolve(root, "node_modules/three/LICENSE"), resolve(distDir, "vendor/three/LICENSE"));

// Slopsmith highway_3d (AGPL-3.0), patched at build time:
// - Three.js is loaded from the copy bundled in the extension instead of Slopsmith's server.
// - The background style defaults to "off" (the particle field costs frames and adds nothing here).
// - The section HUD defaults to the bottom-right corner; the overlay's song info owns the top-right.
// - With `globalThis.__shhHighway.transparent` the canvas clears to alpha 0 and fog is
//   dropped, since fog would fade distant notes into an opaque colour over the page.
// - `globalThis.__shhHighway.antialias === false` turns MSAA off for the performance preset.
const screenSrc = resolve(root, "vendor/slopsmith/highway_3d/screen.js");
let patched = readFileSync(screenSrc, "utf8");
const transparentExpr = "!!(globalThis.__shhHighway && globalThis.__shhHighway.transparent)";
const antialiasExpr = "!(globalThis.__shhHighway && globalThis.__shhHighway.antialias === false)";
const patches = [
  [
    "const THREE_URL = '/static/vendor/three/three.module.min.js';",
    "const THREE_URL = chrome.runtime.getURL('vendor/three/three.module.min.js');",
  ],
  ["const BG_DEFAULTS = { style: 'particles',", "const BG_DEFAULTS = { style: 'off',"],
  ["sectionHudPosition: 'tr'", "sectionHudPosition: 'br'"],
  [
    "ren = new T.WebGLRenderer({ antialias: true });",
    `ren = new T.WebGLRenderer({ antialias: ${antialiasExpr}, alpha: true });`,
  ],
  ["ren.setClearColor(0x101820);", `ren.setClearColor(0x101820, ${transparentExpr} ? 0 : 1);`],
  [
    "scene.fog = new T.Fog(0x101820, FOG_START * 0.8, FOG_END * 1.2);",
    `scene.fog = ${transparentExpr} ? null : new T.Fog(0x101820, FOG_START * 0.8, FOG_END * 1.2);`,
  ],
];
for (const [from, to] of patches) {
  if (!patched.includes(from)) {
    console.error(`Slopsmith screen.js: patch target not found, update scripts/build.mjs:\n  ${from}`);
    process.exit(1);
  }
  patched = patched.replace(from, to);
}
mkdirSync(resolve(distDir, "vendor/slopsmith"), { recursive: true });
writeFileSync(resolve(distDir, "vendor/slopsmith/highway_3d.js"), patched);
copyFile(resolve(root, "vendor/slopsmith/LICENSE"), resolve(distDir, "vendor/slopsmith/LICENSE"));

console.log("Built entries:", entries.join(", "), "+ vendor (three r170, slopsmith highway_3d)");
