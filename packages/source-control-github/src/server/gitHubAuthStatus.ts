import type { GitHubSettings } from "../shared/definition.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const GitHubAuthStatusAccountSchema = Schema.Struct({
  state: Schema.String,
  error: Schema.optional(Schema.String),
  active: Schema.Boolean,
  host: Schema.String,
  login: Schema.String,
  tokenSource: Schema.optional(Schema.String),
});

const GitHubAuthStatusSchema = Schema.Struct({
  hosts: Schema.Record(Schema.String, Schema.Array(GitHubAuthStatusAccountSchema)),
});

const decodeGitHubAuthStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubAuthStatusSchema),
);

export interface GitHubAuthStatusAccount {
  readonly host: string;
  readonly account: string;
  readonly authenticated: boolean;
  readonly active: boolean;
  readonly error: string | null;
  readonly environmentVariable: string | null;
}

export interface GitHubAuthStatus {
  readonly parsed: boolean;
  readonly accounts: ReadonlyArray<GitHubAuthStatusAccount>;
}

const ENVIRONMENT_TOKEN_SOURCE = /^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/u;

function nonEmptyString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseGitHubAuthStatus(text: string): GitHubAuthStatus {
  return Option.match(decodeGitHubAuthStatusJson(text), {
    onNone: () => ({ parsed: false, accounts: [] }),
    onSome: (status) =>
      ({
        parsed: true,
        accounts: Object.values(status.hosts).flatMap((accounts) =>
          accounts.flatMap((account) => {
            const host = nonEmptyString(account.host);
            const login = nonEmptyString(account.login);
            if (host === null || login === null) return [];

            return [
              {
                host: host.toLowerCase(),
                account: login,
                authenticated: account.state === "success",
                active: account.active,
                error: account.error?.trim() || null,
                environmentVariable: ENVIRONMENT_TOKEN_SOURCE.test(account.tokenSource ?? "")
                  ? (account.tokenSource ?? null)
                  : null,
              },
            ];
          }),
        ),
      }) satisfies GitHubAuthStatus,
  });
}

export function findAuthenticatedGitHubAccount(
  accounts: ReadonlyArray<GitHubAuthStatusAccount>,
): GitHubAuthStatusAccount | undefined {
  return (
    accounts.find((account) => account.authenticated && account.active) ??
    accounts.find((account) => account.authenticated)
  );
}

export function effectiveGitHubAccount(
  host: string,
  accounts: ReadonlyArray<GitHubAuthStatusAccount>,
  settings: GitHubSettings,
): GitHubAuthStatusAccount | undefined {
  const choice = settings.hosts[host];
  if (choice?.enabled === false) return undefined;
  const usable = accounts.filter((account) => account.host === host && account.authenticated);
  return (
    usable.find((account) => account.environmentVariable !== null) ??
    (choice?.account === undefined
      ? undefined
      : usable.find((account) => account.account === choice.account)) ??
    findAuthenticatedGitHubAccount(usable)
  );
}
