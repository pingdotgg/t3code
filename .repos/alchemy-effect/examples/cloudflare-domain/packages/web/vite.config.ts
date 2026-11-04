import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
    // The foldkit plugin excludes foldkit from pre-bundling, so its bare
    // imports of the Effect barrels are never discovered. Pre-bundle them,
    // or dev serves every Effect module as its own request and a second copy
    // of Effect next to the app's.
    include: ["effect", "effect/Function", "effect/http", "@effect/platform-browser"],
  },
});
