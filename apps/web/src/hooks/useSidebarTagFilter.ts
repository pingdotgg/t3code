import * as Schema from "effect/Schema";

import { useThreadSelectionStore } from "../threadSelectionStore";
import { useLocalStorage } from "./useLocalStorage";

const SIDEBAR_TAG_FILTER_KEY = "t3code:sidebar:tag-filters";
const tagFilterSchema = Schema.Array(Schema.String);
const NO_TAGS: ReadonlyArray<string> = [];

/** Tags the sidebar is narrowed to on this device; a thread with any of them is listed. Empty lists everything. */
export function useSidebarTagFilter() {
  const [tags, setTags] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    SIDEBAR_TAG_FILTER_KEY,
    NO_TAGS,
    tagFilterSchema,
  );
  const clearSelection = useThreadSelectionStore((store) => store.clearSelection);
  // A selection could otherwise keep threads the new filter hides, and a drag would carry them.
  const setFilter = (next: ReadonlyArray<string>) => {
    clearSelection();
    setTags(next);
  };
  return [tags, setFilter] as const;
}
