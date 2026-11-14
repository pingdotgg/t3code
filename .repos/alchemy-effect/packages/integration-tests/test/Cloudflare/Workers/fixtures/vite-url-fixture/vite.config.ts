import { defineConfig } from "vite";

// `Cloudflare.Worker({ vite })` declares an `ssr` environment but doesn't set
// a worker entry by default. For non-framework projects (no React/Vue plugin
// to inject one), Vite errors out with "rollupOptions.input should not be an
// html file when building for SSR". Point the SSR build at the worker entry so
// the cloudflare-vite-plugin can wrap it into the worker bundle.
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
