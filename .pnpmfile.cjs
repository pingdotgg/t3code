// Windows installs need Linux x64 glibc binaries because WSL shares node_modules.
// Keep other platforms native; release scripts set their own architectures.
module.exports = {
  hooks: {
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
