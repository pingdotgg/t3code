import { defineConfig } from "tsdown";

// Bundle the dev-mode entrypoint at the .js path used by the published package.
export default defineConfig({
  entry: ["bin/exec.ts"],
  format: ["esm"],
  fixedExtension: false,
  clean: false,
  shims: true,
  outDir: "bin",
  dts: false,
  sourcemap: true,
  outputOptions: {
    inlineDynamicImports: true,
  },
  tsconfig: "tsconfig.bundle.json",
});
