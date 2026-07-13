import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const GitHubAuthStatusAccountSchema = Schema.Struct({
  state: Schema.String,
  error: Schema.optional(Schema.String),
  active: Schema.Boolean,
  host: Schema.String,
  login: Schema.String,
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
}

export interface GitHubAuthStatus {
  readonly parsed: boolean;
  readonly accounts: ReadonlyArray<GitHubAuthStatusAccount>;
}

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
              },
            ];
          }),
        ),
      }) satisfies GitHubAuthStatus,
  });
}

const HOST_LINE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$/iu;
const LOGGED_IN_PATTERN = /Logged in to\s+(\S+)\s+(?:account\s+|as\s+)([^\s(]+)/iu;
const LOGIN_FAILED_PATTERN = /Failed to log in to\s+(\S+)\s+(?:account\s+|as\s+)([^\s(]+)/iu;
const ACTIVE_ACCOUNT_PATTERN = /Active account:\s*(true|false)/iu;

/**
 * Parse the human-readable `gh auth status` output.
 *
 * Used as a fallback for CLI versions older than 2.81, which do not support
 * `--json` and would otherwise be reported as unauthenticated. Handles both the
 * current `Logged in to <host> account <login>` phrasing and the older
 * `Logged in to <host> as <login>` form.
 */
type PendingGitHubAuthStatusAccount = Omit<GitHubAuthStatusAccount, "active"> & {
  active: boolean | null;
};

export function parseGitHubAuthStatusText(text: string): GitHubAuthStatus {
  const accounts: Array<PendingGitHubAuthStatusAccount> = [];
  let currentHost: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (rawLine.length === rawLine.trimStart().length && HOST_LINE_PATTERN.test(line)) {
      currentHost = line.toLowerCase();
      continue;
    }

    const active = ACTIVE_ACCOUNT_PATTERN.exec(line)?.[1];
    if (active !== undefined && accounts.length > 0) {
      accounts[accounts.length - 1]!.active = active.toLowerCase() === "true";
      continue;
    }

    const match = LOGGED_IN_PATTERN.exec(line) ?? LOGIN_FAILED_PATTERN.exec(line);
    if (match === undefined || match === null) continue;

    const host = nonEmptyString(match[1] ?? "") ?? currentHost;
    const login = nonEmptyString(match[2] ?? "");
    if (host === null || login === null) continue;

    accounts.push({
      host: host.toLowerCase(),
      account: login,
      authenticated: LOGGED_IN_PATTERN.test(line),
      // Older CLIs omit the `Active account:` line entirely; treat those as active.
      active: null,
      error: null,
    });
  }

  return {
    parsed: accounts.length > 0,
    accounts: accounts.map((entry) => ({ ...entry, active: entry.active ?? true })),
  };
}

export function findAuthenticatedGitHubAccount(
  accounts: ReadonlyArray<GitHubAuthStatusAccount>,
): GitHubAuthStatusAccount | undefined {
  return (
    accounts.find((account) => account.authenticated && account.active) ??
    accounts.find((account) => account.authenticated)
  );
}
