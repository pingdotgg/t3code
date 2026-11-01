import { toggleExpandedParentKey } from "@t3tools/client-runtime/state/child-status-counts";
import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "./useLocalStorage";

// Shared by the sidebar and the Agents board, so opening a parent's child
// chats in one opens them in the other.
const EXPANDED_PARENTS_KEY = "t3code:sidebar:expanded-parents";
const NO_EXPANDED_PARENTS: readonly string[] = [];
const EXPANDED_PARENTS_SCHEMA = Schema.Array(Schema.String);

/** Keys (`environmentId:threadId`) of parents whose child chats are open; all others start collapsed. */
export function useExpandedParentKeys(): readonly string[] {
  return useLocalStorage(EXPANDED_PARENTS_KEY, NO_EXPANDED_PARENTS, EXPANDED_PARENTS_SCHEMA)[0];
}

// Module scope keeps it stable, so memoized toggle rows skip unrelated renders.
export function toggleExpandedParent(parentKey: string) {
  writeLocalStorageValue(
    EXPANDED_PARENTS_KEY,
    (keys) => toggleExpandedParentKey(keys, parentKey),
    NO_EXPANDED_PARENTS,
    EXPANDED_PARENTS_SCHEMA,
  );
}
