import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    outDir: "dist",
    deps: {
      alwaysBundle: [/^@t3tools\/shared(?:\/|$)/, /^effect-codex-app-server(?:\/|$)/],
      onlyBundle: false,
    },
  },
});
