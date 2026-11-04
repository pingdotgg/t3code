import { defineConfig } from "vite";

// Vite's bundled dev mode: the dev server serves the client from an
// in-memory bundle instead of transforming modules on request.
export default defineConfig({
  experimental: { bundledDev: true },
});
