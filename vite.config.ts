import { defineConfig } from "vite";
import { resolve } from "node:path";

// Separate builds so each content/background entry is a single file (no shared chunks).
const entries = {
  content: resolve(__dirname, "src/content/index.ts"),
  inject: resolve(__dirname, "src/inject/main.ts"),
  background: resolve(__dirname, "src/background.ts"),
  detached: resolve(__dirname, "src/detached/main.ts"),
} as const;

export default defineConfig(({ mode }) => {
  const name = (process.env.ENTRY as keyof typeof entries | undefined) ?? "content";
  const entry = entries[name] ?? entries.content;

  return {
    publicDir: name === "content" ? "public" : false,
    build: {
      outDir: "dist",
      emptyOutDir: name === "content",
      sourcemap: true,
      lib: {
        entry,
        name: `SongsterrHighway_${name}`,
        formats: ["iife"],
        fileName: () => `${name}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          assetFileNames: "assets/[name][extname]",
          extend: true,
        },
      },
    },
  };
});
