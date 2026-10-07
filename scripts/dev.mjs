import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const watched = ["src", "public", "vendor"].map((dir) => resolve(root, dir));

let running = null;
let queued = false;
let timer = null;

function build() {
  if (running) {
    queued = true;
    return;
  }
  const started = Date.now();
  running = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
  running.on("exit", (code) => {
    running = null;
    console.log(code === 0 ? `\n[dev] built in ${Date.now() - started} ms — reload the extension in chrome://extensions` : `\n[dev] build failed (${code})`);
    if (queued) {
      queued = false;
      build();
    }
  });
}

for (const dir of watched) {
  watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(build, 200);
  });
}

console.log("[dev] watching src/, public/, vendor/");
build();
