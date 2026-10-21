// Windows WSL dev mode runs the server under Linux from the same node_modules
// as the Windows client, so Windows installs also need Linux x64 glibc native
// modules. Other platforms install only their own binaries; setting this
// everywhere added ~2.2 GB of foreign binaries to every macOS install.
// Release scripts stage their own installs with explicit architectures.
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
