import { defineConfig } from "tsdown";

export default [
  // bundle the CLi into a standalone executable
  // defineConfig({
  //   entry: ["bin/alchemy.ts"],
  //   format: ["esm"],
  //   clean: false,
  //   shims: true,
  //   outDir: "bin",
  //   dts: false,
  //   sourcemap: true,
  //   outputOptions: {
  //     inlineDynamicImports: true,
  //   },
  //   noExternal: ["execa", "open", "env-paths"],
  //   tsconfig: "tsconfig.bundle.json",
  // }),
  // bundle the dev-mode worker entrypoint. dev.ts spawns this in a child bun
  // process; under a published install it loads from node_modules and would
  // otherwise need react/ink/pathe at runtime to resolve InkCLI.tsx as source.
  // Bundling inlines those so they stay devDependencies (same rationale as
  // the cli bundle below).
  defineConfig({
    entry: ["bin/exec.ts"],
    format: ["esm"],
    clean: false,
    shims: true,
    outDir: "bin",
    dts: false,
    sourcemap: true,
    outputOptions: {
      inlineDynamicImports: true,
    },
    tsconfig: "tsconfig.bundle.json",
  }),
];
