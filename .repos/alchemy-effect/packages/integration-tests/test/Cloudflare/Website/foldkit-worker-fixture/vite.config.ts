import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
