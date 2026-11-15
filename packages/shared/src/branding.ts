/**
 * Continuum IDE's identity as a fork of T3 Code: names, OS ids, data folder, release URLs.
 * Rebrand here. `@t3tools/*` scopes, `T3CODE_*` env vars, and wire protocols stay upstream's
 * so upstream merges and the T3 Code mobile app keep working.
 */
export const PRODUCT_BRAND = {
  /** Full product name shown in window titles, installers, and the About panel. */
  baseName: "Continuum IDE",
  shortName: "Continuum",
  description:
    "Continuum IDE is an open-source desktop app for coding agents. Use the agent subscriptions you already have, switch between agents and accounts without losing context, review changes, and run commands in your projects.",
  synopsis: "Desktop IDE for coding agents",
  /** File-name-safe stem used for installers, e.g. `Continuum-IDE-Setup-x64.exe`. */
  artifactStem: "Continuum-IDE",
  /** Linux executable and Debian package name. */
  executableName: "continuum-ide",
  /** Base data directory under the user's home. Kept apart from T3 Code's `~/.t3`. */
  homeDirectoryName: ".continuum",
  /** Electron userData directory names under the platform app-data directory. */
  userDataDirectoryName: "continuum-ide",
  developmentUserDataDirectoryName: "continuum-ide-dev",
  /** Reverse-DNS application id (Windows AppUserModelID, macOS bundle id, AppStream id). */
  desktopAppId: "io.github.swashxdev.continuumide",
  /** Linux WM_CLASS / desktop entry stem; must match `StartupWMClass`. */
  linuxDesktopEntryStem: "io.github.swashxdev.ContinuumIDE",
  maintainer: "Continuum IDE contributors",
  repository: {
    owner: "SwashX-dev",
    name: "continuum-ide",
  },
  upstream: {
    name: "T3 Code",
    repositoryUrl: "https://github.com/pingdotgg/t3code",
    websiteUrl: "https://t3.codes",
  },
} as const;

const repositorySlug = `${PRODUCT_BRAND.repository.owner}/${PRODUCT_BRAND.repository.name}`;

export const PRODUCT_LINKS = {
  repositorySlug,
  repositoryUrl: `https://github.com/${repositorySlug}`,
  releasesUrl: `https://github.com/${repositorySlug}/releases`,
  latestReleaseUrl: `https://github.com/${repositorySlug}/releases/latest`,
  issuesUrl: `https://github.com/${repositorySlug}/issues`,
} as const;

export function resolveLinuxDesktopEntryName(isDevelopment: boolean): string {
  return isDevelopment
    ? `${PRODUCT_BRAND.linuxDesktopEntryStem}.Development.desktop`
    : `${PRODUCT_BRAND.linuxDesktopEntryStem}.desktop`;
}

export function resolveDesktopAppUserModelId(isDevelopment: boolean): string {
  return isDevelopment ? `${PRODUCT_BRAND.desktopAppId}.dev` : PRODUCT_BRAND.desktopAppId;
}
