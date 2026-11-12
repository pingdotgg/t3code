const fs = require("node:fs");
const path = require("node:path");

// Our forks ship as tarballs in apps/mobile/deps. A pnpm patch on one is a second source of
// truth that the next tarball silently drops, so changes go to the fork (apps/mobile/deps/README.md).
function forkTarballPatches(patchedDependencies) {
  const manifestPath = path.join(__dirname, "apps/mobile/package.json");
  // Release staging installs a partial workspace without the mobile app.
  if (!patchedDependencies || !fs.existsSync(manifestPath)) return [];
  const { dependencies = {} } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const forks = Object.keys(dependencies).filter((name) =>
    String(dependencies[name]).startsWith("file:deps/"),
  );
  return Object.keys(patchedDependencies).filter((key) =>
    forks.some((name) => key === name || key.startsWith(`${name}@`)),
  );
}

module.exports = {
  hooks: {
    updateConfig(config) {
      const forkPatches = forkTarballPatches(config.patchedDependencies);
      if (forkPatches.length > 0) {
        throw new Error(
          `pnpm-workspace.yaml patches ${forkPatches.join(", ")}, which ships as a fork tarball in ` +
            "apps/mobile/deps. Change the fork and replace the tarball instead (apps/mobile/deps/README.md).",
        );
      }
      // Windows installs need Linux x64 glibc binaries because WSL shares node_modules.
      // Keep other platforms native; release scripts set their own architectures.
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
