import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const webSrc = fileURLToPath(new URL("../../apps/web/src", import.meta.url));

// No `build` config on purpose: this package is a virtual compile-time surface
// (see README) that resolves through the host app's Vite graph — it is never
// built standalone. This config only serves the package's own tests.
export default defineConfig({
  resolve: {
    alias: {
      "~": webSrc,
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
