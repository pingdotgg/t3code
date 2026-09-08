/**
 * The single source of truth for packages the server CLI bundle must NOT inline.
 *
 * Two consumers derive from this list, and they must never disagree:
 *
 * - apps/server/vite.config.ts decides what stays external to the bundle.
 * - scripts/build-desktop-artifact.ts selects the runtime dependency roots for
 *   the Windows server sidecar.
 *
 * A runtime package that is external but absent from the sidecar fails as soon
 * as Node resolves it from the emitted bundle. Keeping both consumers on one
 * list prevents packaging from drifting away from the bundle boundary.
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
 * only inside the emitted bundle and is unreachable there. This closure is
 * enforced by a test, not by inspection.
 */
export declare const CLI_RUNTIME_EXTERNAL_PREFIXES: readonly [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  "detect-libc",
  "bufferutil",
  "utf-8-validate",
];
/**
 * External only so the bundler never has to resolve them.
 *
 * These are reached through a runtime-conditional dynamic import that Node
 * never takes, and they resolve `bun:*` specifiers that do not exist when
 * bundling for Node. Because Node never loads them, their dependency closure
 * does not need to be external — only the entry point must stay unbundled.
 */
export declare const CLI_BUILD_ONLY_EXTERNAL_PREFIXES: readonly [
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
];
export declare const CLI_EXTERNAL_PACKAGE_PREFIXES: readonly [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  "detect-libc",
  "bufferutil",
  "utf-8-validate",
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
];
export declare function isRuntimeExternalCliDependency(id: string): boolean;
/**
 * True when `id` must stay out of the bundle.
 *
 * This has to be wired to the bundler's `neverBundle`, not just to
 * `alwaysBundle`. `alwaysBundle` only forces packages IN — returning false from
 * it means "no opinion", and the default then applies: a declared dependency
 * stays external, but a transitive one gets bundled. That is how
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc ended up
 * inlined while node-pty (a declared dependency) stayed external.
 */
export declare function isExternalCliDependency(id: string): boolean;
/** True when the CLI bundle should inline `id` rather than leave it external. */
export declare function shouldBundleCliDependency(id: string): boolean;
/** Select direct dependency roots whose runtime closure belongs in the sidecar. */
export declare function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string>;
/**
 * Scan an emitted bundle chunk for runtime-external packages that were inlined.
 *
 * Configuring the bundler is not the same as checking what it produced. The
 * `alwaysBundle` predicate only forces packages IN; returning false from it
 * means "no opinion", so a transitive dependency still gets bundled by default.
 * msgpackr-extract, node-gyp-build-optional-packages and detect-libc were
 * inlined that way while every list-based test passed, which is why this reads
 * the artifact instead.
 *
 * `regionCount` is reported so the caller can tell "nothing was inlined" apart
 * from "the marker format changed and this scan no longer sees anything".
 *
 * `inlinedPackages` is every package seen in a region, which lets the caller
 * check the opposite direction too. Verifying only that externals are absent
 * would still pass if the bundler reverted to leaving everything external: the
 * scan would see source-file regions, report nothing inlined, and the packaged
 * backends would then fail with ERR_MODULE_NOT_FOUND because those packages
 * are not in the selected sidecar closure either.
 */
export declare function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
};
