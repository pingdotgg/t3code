import { useSyncExternalStore } from "react";

import type { EnvironmentIssueEntry } from "./issueList.logic";

/**
 * The Issues the page is showing, and how to open one, for the command palette to search while
 * the Issues list is open. Empty everywhere else.
 */
export interface IssuePaletteSource {
  readonly entries: ReadonlyArray<EnvironmentIssueEntry>;
  readonly open: (entry: EnvironmentIssueEntry) => void;
}

let current: IssuePaletteSource | null = null;
const listeners = new Set<() => void>();

export function publishIssuePaletteSource(source: IssuePaletteSource | null): void {
  current = source;
  for (const listener of listeners) listener();
}

export function useIssuePaletteSource(): IssuePaletteSource | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
