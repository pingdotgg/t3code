import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit(), tailwindcss()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
