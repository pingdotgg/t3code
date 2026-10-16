import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
  readonly latestVersion?: string | null;
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
