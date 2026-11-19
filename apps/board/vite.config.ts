import "vite-plus/test/config";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const electronBundle = {
  format: "cjs" as const,
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  deps: { neverBundle: ["electron"] },
};

export default defineConfig({
  plugins: [tailwindcss()],
  // `dev:web` has no main process, so the lane scripts hand it the engine through these.
  envPrefix: ["VITE_", "AGENT_BOARD_ENGINE_URL", "AGENT_BOARD_TOKEN"],
  server: {
    host: "127.0.0.1",
    port: Number(process.env["PORT"] ?? 5190),
    strictPort: true,
  },
  pack: [
    {
      ...electronBundle,
      entry: { "electron/main": "electron/main.ts" },
      clean: true,
      // The staged app has no node_modules, so the main process carries effect and the T3 packages itself.
      deps: { neverBundle: ["electron"], alwaysBundle: [/^(effect|@effect\/|@t3tools\/|gt-i18n)/] },
    },
    { ...electronBundle, entry: { "electron/preload": "electron/preload.ts" }, clean: false },
  ],
  test: {
    // scripts/*.test.mjs run under node:test, not here.
    include: ["src/**/*.test.ts", "electron/**/*.test.ts"],
  },
});
