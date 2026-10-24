/**
 * Both `apps/desktop/vite.config.ts` and the artifact stage in
 * scripts/build-desktop-artifact.ts derive from this list, so a package that is
 * external is also the only kind of package the staged production install
 * carries.
 */
export const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  // Native addons and the wrappers that dlopen them by real path.
  "@napi-rs/keyring",
  "@crowecawcaw/xa11y",
  "@clerk/electron-passkeys",
  "electron-webauthn",
  "ffi-rs",
  "node-hid",
  "@yuuang/",
  // Reads its own bundle from disk by resolving `playwright-core/package.json`
  // at runtime and ships the browser driver alongside; there is nothing to
  // gain from inlining a 10 MB file the code re-reads as text.
  "playwright-core",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function selectDesktopRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isDesktopRuntimeExternalDependency(name)),
  );
}
