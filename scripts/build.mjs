import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(root, "dist");
const entries = ["content", "inject", "background"];

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

// Slopsmith highway_3d (AGPL-3.0). The only change is where Three.js is loaded
// from: Slopsmith's server path becomes the copy bundled in the extension.
const screenSrc = resolve(root, "vendor/slopsmith/highway_3d/screen.js");
const original = readFileSync(screenSrc, "utf8");
const threeUrlLine = "const THREE_URL = '/static/vendor/three/three.module.min.js';";
if (!original.includes(threeUrlLine)) {
  console.error("Slopsmith screen.js: THREE_URL line not found; update scripts/build.mjs");
  process.exit(1);
}
const patched = original.replace(
  threeUrlLine,
  "const THREE_URL = chrome.runtime.getURL('vendor/three/three.module.min.js');",
);
mkdirSync(resolve(distDir, "vendor/slopsmith"), { recursive: true });
writeFileSync(resolve(distDir, "vendor/slopsmith/highway_3d.js"), patched);
copyFile(resolve(root, "vendor/slopsmith/LICENSE"), resolve(distDir, "vendor/slopsmith/LICENSE"));

console.log("Built entries:", entries.join(", "), "+ vendor (three r170, slopsmith highway_3d)");
