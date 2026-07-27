import "vite-plus/test/config";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently sliding to the next free port (the shell would then
// load a blank window at the configured `devUrl`).
const DEV_PORT = 1420;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // The Rust crate has its own watcher via `tauri dev`; letting Vite walk
      // `target/` costs seconds per restart and finds nothing it can serve.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // WebView2 on Windows 11 ships an evergreen Chromium, so there is no
    // reason to down-level past what it supports.
    target: "chrome120",
    sourcemap: true,
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
