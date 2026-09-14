/**
 * Parses `tea logins list --output json`, which is how T3 learns which Gitea instances the server
 * is authenticated against. Gitea is nearly always self-hosted on a hostname that carries no hint
 * of it, so this list is also the evidence used to refine an otherwise-`unknown` remote to `gitea`.
 */

export interface GiteaLogin {
  /** `tea`'s name for the login, e.g. the value passed to `tea login add --name`. */
  readonly name: string;
  readonly url: string;
  /** Host portion of `url`, lowercased, port stripped. Empty when `url` could not be parsed. */
  readonly hostname: string;
  /** Host `tea` uses for SSH remotes, lowercased, port stripped. Empty when not configured. */
  readonly sshHostname: string;
  readonly user: string | null;
  readonly isDefault: boolean;
}

function asRecordArray(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Strips an optional port and lowercases, so `Git.Example.COM:3000` and `git.example.com` match. */
export function normalizeGiteaHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "";

  // Bracketed IPv6 literals keep their brackets so `[::1]:3000` does not lose its address.
  const bracketed = /^(\[[0-9a-f:.]+\])(?::\d+)?$/u.exec(trimmed);
  if (bracketed?.[1]) return bracketed[1];

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed.replace(/:\d+$/u, "");
  }
}

/**
 * `tea` reports `default` as the string "true"/"false" rather than a boolean, so this reads it
 * loosely instead of trusting the JSON type.
 */
function readDefaultFlag(record: Record<string, unknown>): boolean {
  const value = record["default"];
  if (typeof value === "boolean") return value;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/** Returns an empty list for absent, malformed, or non-JSON output rather than throwing. */
export function parseGiteaLogins(text: string): ReadonlyArray<GiteaLogin> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const logins: GiteaLogin[] = [];
  for (const record of asRecordArray(parsed)) {
    const url = readString(record, "url");
    const sshHost = readString(record, "ssh_host");
    const hostname = normalizeGiteaHostname(url);
    const sshHostname = normalizeGiteaHostname(sshHost);
    if (hostname.length === 0 && sshHostname.length === 0) continue;

    const user = readString(record, "user");
    logins.push({
      name: readString(record, "name"),
      url,
      hostname,
      sshHostname,
      user: user.length > 0 ? user : null,
      isDefault: readDefaultFlag(record),
    });
  }
  return logins;
}

/** The login T3 reports on the Source Control settings card when several instances are configured. */
export function findPrimaryGiteaLogin(logins: ReadonlyArray<GiteaLogin>): GiteaLogin | undefined {
  return (
    logins.find((login) => login.isDefault && login.user !== null) ??
    logins.find((login) => login.user !== null) ??
    logins[0]
  );
}

/**
 * Matches on hostname alone, ignoring ports: a Gitea instance is routinely reached over HTTPS on
 * one port and SSH on another, so an SSH remote would never match its own login if ports had to
 * agree. Scope stays safe because only hosts `tea` is actually authenticated against are consulted.
 */
export function findGiteaLoginForHost(
  logins: ReadonlyArray<GiteaLogin>,
  host: string,
): GiteaLogin | undefined {
  const hostname = normalizeGiteaHostname(host);
  if (hostname.length === 0) return undefined;

  return logins.find(
    (login) =>
      (login.hostname.length > 0 && login.hostname === hostname) ||
      (login.sshHostname.length > 0 && login.sshHostname === hostname),
  );
}
