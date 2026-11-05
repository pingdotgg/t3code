import {
  parseStoredLinearLocation,
  serializeLinearLocation,
  type StoredLinearLocation,
} from "@t3tools/client-runtime/linear/location";
import type { LinearSearch } from "@t3tools/client-runtime/linear/search";

const LINEAR_LOCATION_STORAGE_KEY = "t3.linear.location";
type LocationStorage = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(storage: LocationStorage | undefined): LocationStorage | undefined {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

export function readStoredLinearLocation(storage?: LocationStorage): StoredLinearLocation | null {
  try {
    return parseStoredLinearLocation(resolveStorage(storage)?.getItem(LINEAR_LOCATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The search the Linear entry points open with; the organization is checked once the page loads. */
export function readStoredLinearSearch(storage?: LocationStorage): LinearSearch {
  return readStoredLinearLocation(storage)?.search ?? {};
}

export function writeStoredLinearLocation(
  location: StoredLinearLocation,
  storage?: LocationStorage,
): void {
  try {
    resolveStorage(storage)?.setItem(
      LINEAR_LOCATION_STORAGE_KEY,
      serializeLinearLocation(location),
    );
  } catch {}
}

// Scroll and expanded rows live only for the session: a reload restores the location, not the layout.
const scrollByList = new Map<string, number>();
const expandedByList = new Map<string, Set<string>>();

export function getLinearListScroll(listKey: string): number | undefined {
  return scrollByList.get(listKey);
}

export function setLinearListScroll(listKey: string, scrollTop: number): void {
  scrollByList.set(listKey, scrollTop);
}

export function isLinearIssueExpanded(listKey: string, issueId: string): boolean {
  return expandedByList.get(listKey)?.has(issueId) ?? false;
}

export function setLinearIssueExpanded(listKey: string, issueId: string, expanded: boolean): void {
  const set = expandedByList.get(listKey) ?? new Set<string>();
  if (expanded) set.add(issueId);
  else set.delete(issueId);
  expandedByList.set(listKey, set);
}
