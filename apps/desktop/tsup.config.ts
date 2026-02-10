import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: "cjs",
  outDir: "dist-electron",
  sourcemap: true,
  clean: true,
  noExternal: ["@t3tools/contracts"],
});
