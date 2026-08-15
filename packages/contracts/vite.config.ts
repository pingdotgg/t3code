import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/settings.ts", "src/relay.ts"],
    outDir: "dist",
  },
});
