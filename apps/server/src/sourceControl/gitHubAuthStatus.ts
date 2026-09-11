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

// gh only learned `auth status --json` in 2.81.0, so distributions pinned to an older release
// (Debian and Ubuntu still ship 2.46.0) can report sign-in state through the text output only.
// That text has been stable for years: one `Logged in to <host> account <login>` line per account
// (`as <login>` before 2.40.0), each followed by its own `Active account:` line.
const LOGGED_IN_LINE = /Logged in to (\S+) (?:account|as) ([^\s(]+)/u;
const ACTIVE_ACCOUNT_LINE = /Active account:\s*(\S+)/iu;

export function parseGitHubAuthStatusText(text: string): GitHubAuthStatus {
  const accounts: Array<GitHubAuthStatusAccount> = [];

  for (const line of text.split(/\r?\n/)) {
    const loggedIn = LOGGED_IN_LINE.exec(line);
    const host = loggedIn ? nonEmptyString(loggedIn[1] ?? "") : null;
    const login = loggedIn ? nonEmptyString(loggedIn[2] ?? "") : null;
    if (host !== null && login !== null) {
      accounts.push({
        host: host.toLowerCase(),
        account: login,
        authenticated: true,
        active: false,
        error: null,
      });
      continue;
    }

    const active = ACTIVE_ACCOUNT_LINE.exec(line);
    const current = accounts.at(-1);
    if (active && current) {
      accounts[accounts.length - 1] = { ...current, active: active[1]?.toLowerCase() === "true" };
    }
  }

  return { parsed: accounts.length > 0, accounts };
}

export function findAuthenticatedGitHubAccount(
  accounts: ReadonlyArray<GitHubAuthStatusAccount>,
): GitHubAuthStatusAccount | undefined {
  return (
    accounts.find((account) => account.authenticated && account.active) ??
    accounts.find((account) => account.authenticated)
  );
}
