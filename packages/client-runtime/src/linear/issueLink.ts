import type { LinearConnectionStatus } from "@t3tools/contracts";

const LINEAR_HOST = "linear.app";
const ISSUE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*-\d+$/u;

export interface LinearIssueLink {
  readonly organizationUrlKey: string;
  /** Upper-cased team key and number, e.g. `ATT-123`. */
  readonly identifier: string;
}

/** `https://linear.app/<org>/issue/<KEY-123>[/slug]`; any other host or path is null. */
export function parseLinearIssueUrl(url: string): LinearIssueLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname.toLowerCase() !== LINEAR_HOST) return null;
  const [organizationUrlKey, kind, identifier] = parsed.pathname.split("/").filter(Boolean);
  if (organizationUrlKey === undefined || kind !== "issue" || identifier === undefined) return null;
  if (!ISSUE_IDENTIFIER.test(identifier)) return null;
  return { organizationUrlKey, identifier: identifier.toUpperCase() };
}

/** The identifier to open in the Linear view, or null unless the link is in the connected workspace. */
export function resolveLinearIssueLinkIdentifier(
  url: string,
  status: Pick<LinearConnectionStatus, "state" | "organization"> | null | undefined,
): string | null {
  if (status?.state !== "connected" || !status.organization) return null;
  const link = parseLinearIssueUrl(url);
  if (link === null) return null;
  return link.organizationUrlKey.toLowerCase() === status.organization.urlKey.toLowerCase()
    ? link.identifier
    : null;
}

/** A detail answer belongs to the opened issue when it matches by id or, for links, identifier. */
export function linearIssueMatchesRoute(
  issue: { readonly id: string; readonly identifier: string },
  routeIssueId: string,
): boolean {
  return issue.id === routeIssueId || issue.identifier.toLowerCase() === routeIssueId.toLowerCase();
}
