import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
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
  /** Updates a runtime T3 Code installed itself, used when there is no `update` command. */
  readonly managedUpdate?: ProviderMaintenanceManagedAction;
}

export interface ProviderMaintenanceManagedAction {
  readonly lockKey: string;
  /** Completes once the new runtime is installed. `onProgress` takes each step's status line. */
  readonly run: (
    onProgress: (message: string) => Effect.Effect<void>,
  ) => Effect.Effect<void, Error>;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** The provider's environment, including its PATH and custom home. */
  readonly env?: NodeJS.ProcessEnv;
}
