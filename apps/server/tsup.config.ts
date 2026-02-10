import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@t3tools/contracts"],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
});
