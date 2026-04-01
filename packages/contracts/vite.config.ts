import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/settings.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist",
    clean: true,
  },
});
