import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  pack: {
    entry: ["src/bin.ts"],
    format: ["esm", "cjs"],
    checks: {
      legacyCjs: false,
    },
    outDir: "dist",
    sourcemap: true,
    clean: true,
    noExternal: (id) => id.startsWith("@t3tools/"),
    inlineOnly: false,
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
