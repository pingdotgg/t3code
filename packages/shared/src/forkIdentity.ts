/**
 * Fork identity: every value that must differ from upstream `pingdotgg/t3code` so this fork
 * (`latheworks/t3code`) installs and runs beside the upstream nightly. Upstream files consume it
 * through one import and a one-line literal swap so merges stay mechanical. Keep it
 * dependency-free: the web bundle imports it too.
 */
export const FORK_IDENTITY = Object.freeze({
  npmPackageName: "@jamesainslie/lathe",
  cliBin: "lathe",
  baseDirName: ".lathe",
  /**
   * The base directory before the Lathe rename. An existing one is used in
   * place while `baseDirName` is absent; see `forkBaseDir.ts`.
   */
  legacyBaseDirName: ".t3f",
  /**
   * Prefix of temporary worktree branches (`lathe/<8 hex>`). Threads from before
   * the Lathe rename hold `legacyWorktreeBranchPrefix`, which stays temporary so
   * their branches are still renamed. Also the default `branchNamePrefix`, which
   * packages/contracts mirrors as a literal because it cannot import this package.
   */
  worktreeBranchPrefix: "lathe",
  legacyWorktreeBranchPrefix: "t3code",
  /** Repository directory holding the fork's icon sets, in place of upstream's `assets`. */
  assetsDir: "assets/lathe",
  defaultPort: 4773,
  /**
   * Upstream's usage telemetry posts to T3 Tools' PostHog project. Lathe sends
   * none unless `LATHE_TELEMETRY_ENABLED=true` opts in.
   */
  telemetryEnabledByDefault: false,
  productBaseName: "Lathe",
  /** The fork's copyright holder, shown in the desktop About window. */
  author: "James Ainslie",
  artifactBaseName: "Lathe",
  appId: "us.ainslies.t3code",
  repositoryUrl: "https://github.com/latheworks/t3code",
  /** GitHub `owner/repo` whose releases host the CLI archives and SHA256SUMS. */
  releaseRepository: "latheworks/t3code",
  releasesUrl: "https://github.com/latheworks/t3code/releases",
  urlHandlerDesktopEntryName: "lathe-url-handler.desktop",
  /**
   * electron-updater's download cache under the OS cache dir. electron-builder
   * names it after the bundled package.json name, `lathe` in both apps, so the
   * desktop swaps it in at runtime (`DesktopForkUpdaterCacheDir`).
   */
  updaterCacheDirName: "lathe-updater",
  /** Debian control fields for the Linux .deb; upstream's package is named `t3code`. */
  linuxPackage: Object.freeze({
    name: "lathe",
    maintainer: "James Ainslie <42301770+jamesainslie@users.noreply.github.com>",
  }),
  // Service names keep their pre-rename values: a renamed unit would leave the
  // old one installed and restarting beside it.
  bootService: Object.freeze({
    systemdName: "t3code-fork",
    launchdLabel: "us.ainslies.t3code.service",
  }),
  desktop: Object.freeze({
    production: Object.freeze({
      appId: "us.ainslies.t3code",
      scheme: "lathe",
      executableName: "lathe",
      userDataDirName: "lathe",
      /** The pre-rename profile, used in place when it exists. */
      legacyUserDataDirName: "t3code-fork",
      /** Renderer scheme before the rename; its localStorage is imported once. */
      legacyScheme: "t3code-fork",
      desktopEntryName: "lathe.desktop",
      wmClass: "lathe",
    }),
    development: Object.freeze({
      appId: "us.ainslies.t3code.dev",
      scheme: "lathe-dev",
      executableName: "lathe-dev",
      userDataDirName: "lathe-dev",
      legacyUserDataDirName: "t3code-fork-dev",
      legacyScheme: "t3code-fork-dev",
      desktopEntryName: "lathe-dev.desktop",
      wmClass: "lathe-dev",
    }),
  }),
} as const);

/** Widened shape shared by the production and development desktop identifiers. */
export type ForkDesktopIds = Readonly<
  Record<keyof typeof FORK_IDENTITY.desktop.production, string>
>;

/** Desktop identifiers for the running environment (dev builds get `-dev` variants). */
export const forkDesktopIds = (isDevelopment: boolean): ForkDesktopIds =>
  isDevelopment ? FORK_IDENTITY.desktop.development : FORK_IDENTITY.desktop.production;

/** `@jamesainslie/lathe@<version or dist-tag>` for npm and npx invocations. */
export const forkPackageSpec = (versionOrTag: string): string =>
  `${FORK_IDENTITY.npmPackageName}@${versionOrTag}`;

/** Every URL scheme the fork desktop registers, production first. */
export const forkDesktopSchemes = [
  FORK_IDENTITY.desktop.production.scheme,
  FORK_IDENTITY.desktop.development.scheme,
] as const;
