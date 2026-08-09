/**
 * The single source of truth for packages the server CLI bundle must NOT inline.
 *
 * Two consumers derive from this list, and they must never disagree:
 *
 * - apps/server/vite.config.ts decides what stays external to the bundle.
 * - scripts/build-desktop-artifact.ts decides what gets unpacked out of the asar.
 *
 * A package that is external but not unpacked still resolves on the Windows
 * primary, which runs under ELECTRON_RUN_AS_NODE and reads app.asar
 * transparently. It fails only under WSL, where the backend is launched as plain
 * `wsl.exe -- node` and cannot read inside an archive. That asymmetry makes the
 * drift invisible on the platform you are most likely to test on, which is why
 * both consumers derive from one list instead of maintaining their own.
 *
 * Entries are matched as prefixes (`id.startsWith(prefix)`), so they also cover
 * a package's platform-specific siblings — `node-gyp-build` covers
 * `node-gyp-build-optional-packages`, `@yuuang/` covers every `ffi-rs-*` binding.
 */
/**
 * External because Node actually loads them from disk at runtime.
 *
 * Native addons (.node), the JS wrappers that dlopen them by real path, and —
 * critically — the ordinary JS packages those wrappers require. An external
 * package is loaded from the real filesystem, so its own `require` also
 * resolves from the real filesystem; a dependency that was bundled away exists
 * only inside app.asar and is unreachable there. This closure is enforced by a
 * test, not by inspection.
 */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  // Required by node-gyp-build-optional-packages. Not native, but in the
  // closure: without it, WSL gets MODULE_NOT_FOUND while Windows is fine.
  "detect-libc",
] as const;

/**
 * External only so the bundler never has to resolve them.
 *
 * These are reached through a runtime-conditional dynamic import that Node
 * never takes, and they resolve `bun:*` specifiers that do not exist when
 * bundling for Node. Because Node never loads them, their dependency closure
 * does not need to be external — only the entry point must stay unbundled.
 */
export const CLI_BUILD_ONLY_EXTERNAL_PREFIXES = [
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
] as const;

export const CLI_EXTERNAL_PACKAGE_PREFIXES = [
  ...CLI_RUNTIME_EXTERNAL_PREFIXES,
  ...CLI_BUILD_ONLY_EXTERNAL_PREFIXES,
] as const;

/** True when the CLI bundle should inline `id` rather than leave it external. */
export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !CLI_EXTERNAL_PACKAGE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * asar-unpack globs covering every external package.
 *
 * The trailing `*` is what keeps these aligned with the prefix matching above:
 * without it, `node-gyp-build` would be left external by the bundler and then
 * not unpacked, because the real package is `node-gyp-build-optional-packages`.
 *
 * pnpm stores real files under `.pnpm` and symlinks the top-level names, so both
 * paths are unpacked for the link target to exist on disk.
 */
export const CLI_EXTERNAL_PACKAGE_UNPACK_GLOBS = CLI_EXTERNAL_PACKAGE_PREFIXES.flatMap(
  (prefix) =>
    [`node_modules/${prefix}*/**/*`, `node_modules/.pnpm/**/node_modules/${prefix}*/**/*`] as const,
);
