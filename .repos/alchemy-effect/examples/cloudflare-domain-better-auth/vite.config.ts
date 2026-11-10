import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/web/entry.ts"],
    include: ["effect", "effect/Function", "effect/http", "@effect/platform-browser"],
  },
});
