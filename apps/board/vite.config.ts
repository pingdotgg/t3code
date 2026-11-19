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
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
  },
  pack: [
    { ...electronBundle, entry: { "electron/main": "electron/main.ts" }, clean: true },
    { ...electronBundle, entry: { "electron/preload": "electron/preload.ts" }, clean: false },
  ],
  test: {
    // scripts/*.test.mjs run under node:test, not here.
    include: ["src/**/*.test.ts"],
  },
});
