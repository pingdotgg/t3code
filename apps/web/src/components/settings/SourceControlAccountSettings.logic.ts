import type { SourceControlProviderAuth } from "@t3tools/contracts";
import type { HostCredentialSettings } from "@t3tools/client-runtime/source-control-clients";

export type DiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface HostAccountGroup {
  readonly host: string;
  readonly activeAccount: string | null;
  readonly selectable: ReadonlyArray<string>;
  readonly broken: ReadonlyArray<DiscoveredAccount>;
  readonly environmentVariable: string | null;
}

export function groupHostAccounts(
  accounts: ReadonlyArray<DiscoveredAccount>,
): ReadonlyArray<HostAccountGroup> {
  const hosts = [...new Set(accounts.map((entry) => entry.host))];
  return hosts.map((host) => {
    const entries = accounts.filter((entry) => entry.host === host);
    const stored = entries.filter((entry) => entry.environmentVariable === undefined);
    const selectable = stored.filter((entry) => entry.authenticated);
    return {
      host,
      activeAccount: (selectable.find((entry) => entry.active) ?? selectable[0])?.account ?? null,
      selectable: selectable.map((entry) => entry.account),
      broken: stored.filter((entry) => !entry.authenticated),
      environmentVariable:
        entries.find((entry) => entry.environmentVariable)?.environmentVariable ?? null,
    };
  });
}

export function nextHostAccountChoices(
  current: HostCredentialSettings["hosts"],
  host: string,
  change: { readonly enabled?: boolean; readonly account?: string | null },
): HostCredentialSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}
