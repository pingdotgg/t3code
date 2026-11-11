import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// SSR: every page renders on request; nothing is prerendered.
export default defineConfig({
  plugins: [
    foldkit({
      ssr: {
        serverEntry: "/src/entry.server.ts",
        clientEntry: "/src/entry.ts",
        build: { prerender: false },
      },
    }),
  ],
});
