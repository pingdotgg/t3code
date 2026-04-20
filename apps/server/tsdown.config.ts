import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => id.startsWith("@t3tools/") || id.startsWith("effect-acp"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
