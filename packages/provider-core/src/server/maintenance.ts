import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Set, with `update` null, when T3 Code installs the provider's runtime itself: updating is a
   * reinstall by the server, with no command to run or show.
   */
  readonly managedInstall?: {
    readonly lockKey: string;
    /** Refresh the offer for an explicit check or update. Routine probes use latestVersion. */
    readonly refreshLatestVersion?: Effect.Effect<string | null>;
  };
  /** undefined defers to npm; null means the installer could not determine the latest version. */
  readonly latestVersion?: string | null;
  /**
   * Deferred until update checks are enabled; `null` falls back to
   * `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  /** Separates installer release channels that share an update command. */
  readonly latestVersionCacheKey?: string;
  readonly compareVersions?: (current: string, latest: string) => number;
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
  /** Displayed for manual updates; never executed by T3 Code. */
  readonly manualCommand?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** The provider's environment, including its PATH and custom home. */
  readonly env?: NodeJS.ProcessEnv;
}
