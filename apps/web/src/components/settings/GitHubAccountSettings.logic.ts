import type { GitHubSettings, SourceControlProviderAuth } from "@t3tools/contracts";

export type GitHubDiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface GitHubHostGroup {
  readonly host: string;
  /** gh's active stored login, the one used when Settings pin nothing. */
  readonly activeAccount: string | null;
  /** Stored logins that work and can be pinned with `gh auth token --user`. */
  readonly selectable: ReadonlyArray<string>;
  /** Logins gh holds but cannot use; shown with their error. */
  readonly broken: ReadonlyArray<GitHubDiscoveredAccount>;
  /** Set when GH_TOKEN or a sibling overrides every stored login for this host. */
  readonly environmentVariable: string | null;
}

/** Groups gh's logins by host, in the order gh reported the hosts. */
export function groupGitHubAccounts(
  accounts: ReadonlyArray<GitHubDiscoveredAccount>,
): ReadonlyArray<GitHubHostGroup> {
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

/**
 * The full `hosts` map after one host changes. Hosts left on gh's defaults (enabled,
 * no pinned account) are dropped so settings only hold real choices.
 */
export function nextGitHubHosts(
  current: GitHubSettings["hosts"],
  host: string,
  change: { readonly enabled?: boolean; readonly account?: string | null },
): GitHubSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}
