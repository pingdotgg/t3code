import { octane } from "@octanejs/vite-plugin";
import { defineConfig } from "vite";

// Client-only Octane app: NO `octane.config.ts` (no routes, no adapter) —
// just the `octane()` compiler plugin. This is the documented
// `Cloudflare.Website.Vite` path for route-less Octane apps: the plugin
// composes with the injected Cloudflare Vite plugin and the project builds
// as a plain Vite SPA (assets only, no worker entry).
export default defineConfig({
  plugins: [octane()],
  build: { target: "esnext" },
});
