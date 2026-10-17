import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version when `lookupLatestVersion` is absent or finds nothing.
   * `undefined` means the npm registry entry for `packageName` is
   * authoritative; `null` means the installer's own channel is the only one
   * that counts, so the latest version is unknown.
   */
  readonly latestVersion?: string | null;
  /**
   * Asks the installer which version its update command would install. It
   * contacts the registry, so it runs only with update checks; `null` falls
   * back to `latestVersion`, then the npm registry entry.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  readonly compareVersions?: (current: string, latest: string) => number;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}
