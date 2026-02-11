import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: ["@t3tools/contracts", "zod"],
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
