import * as Result from "effect/Result";

import type { GitHubAccountSelection, ServerSettings } from "@t3tools/contracts";

export interface GitHubCredentialTarget {
  readonly host?: string;
  readonly repositories?: ReadonlyArray<string>;
}

export interface GitHubCredentialRoute {
  readonly host: string;
  readonly key: string;
  readonly account: GitHubAccountSelection | undefined;
}

export type GitHubCredentialRoutingError =
  | {
      readonly _tag: "SelectionConflict";
      readonly repositories: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "HostMismatch";
      readonly accountHost: string;
      readonly login: string;
    };

type GitHubCredentialSettings = Pick<
  ServerSettings,
  "githubDefaultAccounts" | "githubAccountOverrides"
>;

export function accountKey(account: GitHubAccountSelection): string {
  return `${account.host.toLowerCase()}\n${account.login.toLowerCase()}\n${account.tokenSource}`;
}

/** Selects an account without reading credentials or performing any other effects. */
export function selectCredentialRoute(
  settings: GitHubCredentialSettings,
  target: GitHubCredentialTarget,
): Result.Result<GitHubCredentialRoute, GitHubCredentialRoutingError> {
  const host = (target.host ?? "github.com").toLowerCase();
  const defaults = new Map(
    Object.entries(settings.githubDefaultAccounts).map(([accountHost, account]) => [
      accountHost.toLowerCase(),
      account,
    ]),
  );
  const overrides = new Map(
    Object.entries(settings.githubAccountOverrides).map(([ownerKey, account]) => [
      ownerKey.toLowerCase(),
      account,
    ]),
  );
  const defaultAccount = defaults.get(host);
  const repositories = target.repositories ?? [];
  const accounts =
    repositories.length === 0
      ? [defaultAccount]
      : repositories.map((repository) => {
          const owner = repository.trim().split("/")[0]?.toLowerCase();
          return owner === undefined
            ? defaultAccount
            : (overrides.get(`${host}/${owner}`) ?? defaultAccount);
        });
  const byKey = new Map(
    accounts.map((account) => [
      account === undefined ? `active:${host}` : accountKey(account),
      account,
    ]),
  );
  if (byKey.size > 1) {
    return Result.fail({ _tag: "SelectionConflict", repositories: [...repositories] });
  }
  const [key, account] = byKey.entries().next().value ?? [`active:${host}`, undefined];
  if (account !== undefined && account.host.toLowerCase() !== host) {
    return Result.fail({
      _tag: "HostMismatch",
      accountHost: account.host,
      login: account.login,
    });
  }
  return Result.succeed({ host, key, account });
}
