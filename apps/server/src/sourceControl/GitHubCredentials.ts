import * as Result from "effect/Result";

import type { GitHubAccountSelection, ServerSettings } from "@t3tools/contracts";

export type GitHubCredentialTarget =
  | { readonly host?: undefined; readonly repositories?: undefined }
  | { readonly host?: string; readonly repositories: ReadonlyArray<string> };

export interface GitHubCredentialRoute {
  readonly host: string;
  readonly key: string;
  readonly account: GitHubAccountSelection | undefined;
}

export interface GitHubCredentialRoutingError {
  readonly _tag: "SelectionConflict";
  readonly repositories: ReadonlyArray<string>;
}

type GitHubCredentialSettings = Pick<ServerSettings, "githubAccountRouting">;

function accountKey(host: string, account: GitHubAccountSelection): string {
  return `${host.toLowerCase()}\n${account.login.toLowerCase()}\n${account.tokenSource}`;
}

/** Selects an account without reading credentials or performing any other effects. */
export function selectCredentialRoute(
  settings: GitHubCredentialSettings,
  target: GitHubCredentialTarget,
): Result.Result<GitHubCredentialRoute, GitHubCredentialRoutingError> {
  const host = (target.host ?? "github.com").toLowerCase();
  const routing = Object.entries(settings.githubAccountRouting).find(
    ([accountHost]) => accountHost.toLowerCase() === host,
  )?.[1];
  const overrides = new Map(
    Object.entries(routing?.ownerOverrides ?? {}).map(([owner, account]) => [
      owner.toLowerCase(),
      account,
    ]),
  );
  const defaultAccount = routing?.defaultAccount;
  const repositories = target.repositories ?? [];
  const accounts =
    repositories.length === 0
      ? [defaultAccount]
      : repositories.map((repository) => {
          const owner = repository.trim().split("/")[0]?.toLowerCase();
          return owner === undefined ? defaultAccount : (overrides.get(owner) ?? defaultAccount);
        });
  const byKey = new Map(
    accounts.map((account) => [
      account === undefined ? `active:${host}` : accountKey(host, account),
      account,
    ]),
  );
  if (byKey.size > 1) {
    return Result.fail({ _tag: "SelectionConflict", repositories: [...repositories] });
  }
  const [key, account] = byKey.entries().next().value ?? [`active:${host}`, undefined];
  return Result.succeed({ host, key, account });
}
