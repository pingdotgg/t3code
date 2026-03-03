import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@t3tools/contracts"],
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
