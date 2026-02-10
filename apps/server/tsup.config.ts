import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@acme/contracts"],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
});
