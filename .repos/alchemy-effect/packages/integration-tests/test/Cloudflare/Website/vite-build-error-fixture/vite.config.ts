import { defineConfig } from "vite";

// Point the SSR build at the worker entry (see `vite-fixture/vite.config.ts`).
export default defineConfig({
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "./src/worker.ts",
        },
      },
    },
  },
});
