import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// The deployment this build belongs to. The server stamps it on the rendered
// root and the client carries the same value, so hydration can refuse a page
// from a different deployment before adopting its DOM. A hydratable render
// fails without one, so a build must always have it: CI supplies a real
// per-deployment value and a local build falls back to a fresh one rather
// than a constant, which would make a stale page look current.
const buildId =
  process.env.FOLDKIT_BUILD_ID ?? `local-${Date.now().toString(36)}`;

export default defineConfig({
  // NOTE: the plugin's `ssr: { serverEntry }` option is deliberately NOT set.
  // It serves rendered pages from the Vite dev server by loading the entry
  // through `ssrLoadModule`, which requires a runnable `ssr` environment —
  // and under `alchemy dev` that environment belongs to workerd, which is not
  // runnable. It is also redundant here: requests reach `src/worker.ts`,
  // which renders through the same entry.
  plugins: [foldkit({ buildId })],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
