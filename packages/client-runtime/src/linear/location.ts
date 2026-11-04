import { parseLinearSearch, type LinearSearch } from "./search.ts";

/** Where the user last was on the Linear page, remembered per device across reloads. */
export interface StoredLinearLocation {
  /** The Linear organization the location belongs to; null while it is not yet known. */
  readonly organizationId: string | null;
  readonly search: LinearSearch;
}

const MAX_STORED_LENGTH = 8_000;

export function serializeLinearLocation(location: StoredLinearLocation): string {
  return JSON.stringify({
    organizationId: location.organizationId,
    search: parseLinearSearch(location.search as Record<string, unknown>),
  });
}

/** Null for anything missing, malformed or oversized, so callers fall back to `{}`. */
export function parseStoredLinearLocation(
  raw: string | null | undefined,
): StoredLinearLocation | null {
  if (!raw || raw.length > MAX_STORED_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { organizationId, search } = value as Record<string, unknown>;
    if (typeof search !== "object" || search === null) return null;
    return {
      organizationId: typeof organizationId === "string" ? organizationId : null,
      search: parseLinearSearch(search as Record<string, unknown>),
    };
  } catch {
    return null;
  }
}

/**
 * The search to open the page with. A location saved for another organization points at ids that do
 * not exist here, so it is dropped. An unknown current organization trusts the stored one.
 */
export function resolveStoredLinearSearch(
  stored: StoredLinearLocation | null,
  organizationId: string | null,
): LinearSearch {
  if (stored === null) return {};
  if (
    organizationId !== null &&
    stored.organizationId !== null &&
    stored.organizationId !== organizationId
  ) {
    return {};
  }
  return stored.search;
}

/**
 * True when the page opened on a search that was restored from another organization's location. The
 * ids in it do not exist in this workspace, so the page resets instead of showing broken scopes.
 */
export function isStaleLocationForOrganization(
  stored: StoredLinearLocation | null,
  organizationId: string | null,
  search: LinearSearch,
): boolean {
  if (stored === null || organizationId === null || stored.organizationId === null) return false;
  if (stored.organizationId === organizationId) return false;
  return (
    JSON.stringify(parseLinearSearch(search as Record<string, unknown>)) ===
    JSON.stringify(stored.search)
  );
}

/** Identifies one list for in-session scroll and expanded-row memory; the selected issue is excluded. */
export function linearListKey(search: LinearSearch): string {
  const { issue: _issue, ...rest } = parseLinearSearch(search as Record<string, unknown>);
  return JSON.stringify(rest);
}
