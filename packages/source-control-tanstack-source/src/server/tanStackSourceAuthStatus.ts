export interface TanStackSourceAuthAccount {
  readonly host: string;
  readonly account: string;
  readonly authenticated: boolean;
  readonly active: boolean;
  readonly error: string | null;
  /** Set when the login is `SRC_TOKEN`, which `src` puts before every saved login. */
  readonly environmentVariable: string | null;
}

const HOST_LINE = /^([a-z0-9][a-z0-9.-]*(?::\d+)?)$/iu;
const ACCOUNT_LINE =
  /^\s*(?:✓|X)\s+(Logged in|Failed to log in) to (\S+) (?:account (\S+)(?: \(([A-Z][A-Z0-9_]*)\))?|using token \(([A-Z][A-Z0-9_]*)\))/u;
const ACTIVE_LINE = /^\s*-\s+Active account:\s+(true|false)\s*$/u;
const DETAIL_LINE = /^\s*-\s+(.+)$/u;
const SAFE_DETAIL = /^(?!Token:|Git operations protocol:)/u;

/**
 * `src auth status` speaks `gh auth status`'s text (it has no `--json`): a host line, then per
 * login a `✓`/`X` line and indented `- key: value` lines, the last of a failed one its reason.
 */
export function parseTanStackSourceAuthStatus(
  text: string,
): ReadonlyArray<TanStackSourceAuthAccount> {
  const accounts: Array<TanStackSourceAuthAccount> = [];
  let current: {
    host: string;
    account: string;
    authenticated: boolean;
    active: boolean;
    error: string | null;
    environmentVariable: string | null;
  } | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (HOST_LINE.test(line.trim()) && !line.startsWith(" ")) {
      current = null;
      continue;
    }
    const login = ACCOUNT_LINE.exec(line);
    if (login !== null) {
      const variable = login[4] ?? login[5] ?? null;
      current = {
        host: login[2]!.toLowerCase(),
        // A refused SRC_TOKEN names no account; it is reported, but is no login to pick.
        account: login[3] ?? "",
        authenticated: login[1] === "Logged in",
        active: false,
        error: null,
        environmentVariable: variable,
      };
      accounts.push(current);
      continue;
    }
    if (current === null) continue;
    const active = ACTIVE_LINE.exec(line);
    if (active !== null) {
      current.active = active[1] === "true";
      continue;
    }
    const detail = DETAIL_LINE.exec(line)?.[1]?.trim();
    if (!current.authenticated && detail !== undefined && SAFE_DETAIL.test(detail))
      current.error = detail;
  }
  return accounts;
}
