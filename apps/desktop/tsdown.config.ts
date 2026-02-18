import { defineConfig } from "tsdown";

export default defineConfig([
  {
    outDir: "dist-electron",
    sourcemap: true,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: ["@t3tools/contracts"],
    format: "esm",
  },
  {
    outDir: "dist-electron",
    sourcemap: true,
    entry: ["src/preload.ts"],
    clean: true,
    noExternal: ["@t3tools/contracts"],
    format: "cjs",
  },
]);
