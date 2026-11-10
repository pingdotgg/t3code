import { defineConfig } from "vite";

// The client environment's default entry is `index.html`; this app is
// worker-rendered, so point the client build at a tiny JS entry instead
// (which also imports across the workspace boundary, exercising the
// collector's external-workspace detection in a second environment).
export default defineConfig({
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: "src/client.ts",
        },
      },
    },
  },
});
