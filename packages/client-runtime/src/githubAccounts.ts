/**
 * GitHub account choices as Source Control settings draw and edit them, on web and mobile alike.
 * The logins come from `gh` on the server through discovery; the choices are GitHub's settings.
 *
 * @module client-runtime/githubAccounts
 */
import {
  pullRequestHostOf,
  type RepositoryIdentity,
  SourceControlProviderKind,
  type SourceControlProviderAuth,
} from "@t3tools/contracts";
import type { GitHubSettings } from "@t3tools/source-control-github/client/definition";

const GITHUB = SourceControlProviderKind.make("github");

export type GitHubDiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface GitHubHostGroup {
  readonly host: string;
  readonly activeAccount: string | null;
  readonly selectable: ReadonlyArray<string>;
  readonly broken: ReadonlyArray<GitHubDiscoveredAccount>;
  readonly environmentVariable: string | null;
}

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

type AccountRules = Readonly<Record<string, string>>;

const hasRules = (rules: AccountRules | undefined): rules is AccountRules =>
  rules !== undefined && Object.keys(rules).length > 0;

export function nextGitHubHosts(
  current: GitHubSettings["hosts"],
  host: string,
  change: {
    readonly enabled?: boolean;
    readonly account?: string | null;
    readonly owners?: AccountRules;
    readonly repositories?: AccountRules;
  },
): GitHubSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const owners = change.owners ?? previous?.owners;
  const repositories = change.repositories ?? previous?.repositories;
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined && !hasRules(owners) && !hasRules(repositories)) {
    return rest;
  }
  return {
    ...rest,
    [host]: {
      enabled,
      ...(account === undefined ? {} : { account }),
      ...(hasRules(owners) ? { owners } : {}),
      ...(hasRules(repositories) ? { repositories } : {}),
    },
  };
}

/**
 * Owner or repository rules after one changes; `null` drops the rule, so the owner falls back to
 * the host's account and the repository to its owner's.
 */
export function nextGitHubRules(
  current: AccountRules | undefined,
  key: string,
  account: string | null,
): AccountRules {
  const normalized = key.trim().toLowerCase();
  const { [normalized]: _replaced, ...rest } = current ?? {};
  return account === null ? rest : { ...rest, [normalized]: account };
}

/**
 * The GitHub host and lowercased `owner/name` a project's repository is read as, which is what
 * a repository rule is keyed by, or null for a repository that is not on a GitHub host.
 */
export function gitHubRepositoryOf(
  identity: RepositoryIdentity | null | undefined,
): { readonly host: string; readonly repository: string } | null {
  const owner = identity?.owner?.trim().toLowerCase();
  const name = identity?.name?.trim().toLowerCase();
  if (!identity || !owner || !name) return null;
  return { host: pullRequestHostOf(identity, GITHUB), repository: `${owner}/${name}` };
}

/**
 * The repository owners on `host` an account can be chosen for: every owner this environment's
 * projects there belong to, and any that already has a rule, sorted.
 */
export function gitHubOwnersOnHost(
  host: string,
  identities: ReadonlyArray<RepositoryIdentity | null | undefined>,
  rules: AccountRules | undefined,
): ReadonlyArray<string> {
  const owners = new Set(Object.keys(rules ?? {}));
  for (const identity of identities) {
    const owner = identity?.owner?.trim().toLowerCase();
    if (owner && pullRequestHostOf(identity, GITHUB) === host) owners.add(owner);
  }
  return [...owners].sort((left, right) => left.localeCompare(right));
}
