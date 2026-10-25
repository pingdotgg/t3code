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
  readonly compareVersions?: (current: string, latest: string) => number;
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Native updaters must use the instance's custom home (e.g. `CODEX_HOME`). */
  readonly env?: NodeJS.ProcessEnv;
}
