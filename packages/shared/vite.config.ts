import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: [
      "src/DrainableWorker.ts",
      "src/KeyedCoalescingWorker.ts",
      "src/Net.ts",
      "src/String.ts",
      "src/Struct.ts",
      "src/git.ts",
      "src/logging.ts",
      "src/model.ts",
      "src/schemaJson.ts",
      "src/shell.ts",
    ],
    format: "esm",
    dts: true,
    outDir: "dist",
    clean: true,
  },
});
