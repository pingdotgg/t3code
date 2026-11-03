// Windows installs need Linux x64 glibc binaries because WSL shares node_modules.
// Keep other platforms native; release scripts set their own architectures.
module.exports = {
  hooks: {
    // `typescript` is @tsc-rs/typescript (the catalog entry). Its npm version (0.8.x) is outside
    // vite-plus-core's typescript peer range, so pnpm gave the vite-plus that @effect/vitest
    // imports apps/marketing's typescript@6.0.3 instead, and tests loaded a second vitest.
    readPackage(pkg) {
      if (pkg.name === "@voidzero-dev/vite-plus-core" && pkg.peerDependencies?.typescript) {
        pkg.peerDependencies.typescript = "*";
      }
      return pkg;
    },
    updateConfig(config) {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- pnpm loads this file before any Effect runtime exists.
      if (process.platform !== "win32") return config;
      return {
        ...config,
        supportedArchitectures: {
          os: ["current", "linux"],
          cpu: ["current", "x64"],
          libc: ["current", "glibc"],
        },
      };
    },
  },
};
