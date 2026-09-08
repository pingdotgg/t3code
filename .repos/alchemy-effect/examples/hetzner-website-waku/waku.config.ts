import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "waku/config";

// Loaded natively by Alchemy's Waku integration — the same
// `vite.runnerImport("/waku.config")` semantics as waku's own CLI. Vite
// plugins for a Waku project go here (a standalone vite.config.ts is not
// read); do NOT set `unstable_adapter` — Alchemy owns the AWS adapter.
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
