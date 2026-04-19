import { Schema } from "effect";
import { useCallback } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import type { WorkspacePaneId, WorkspacePaneVisibilityMap } from "./types";

const VISIBILITY_STORAGE_KEY = "workbench:console:pane-visibility:v1";
const COLLAPSED_STORAGE_KEY = "workbench:console:pane-collapsed:v1";

const VisibilitySchema = Schema.Struct({
  tree: Schema.Boolean,
  recent: Schema.Boolean,
  task: Schema.Boolean,
});

const CollapsedSchema = Schema.Struct({
  tree: Schema.Boolean,
  recent: Schema.Boolean,
  task: Schema.Boolean,
});

const DEFAULT_VISIBILITY: WorkspacePaneVisibilityMap = {
  // The Console should immediately surface the three core panes users rely
  // on most: files, recent edited files, and tasks.
  tree: true,
  recent: true,
  task: true,
};

const DEFAULT_COLLAPSED: WorkspacePaneVisibilityMap = {
  tree: false,
  recent: false,
  task: false,
};

/**
 * Persisted "which cards are visible in the stack" map. The viewer is
 * intentionally not in this map — it's not a stack card, it's the takeover
 * overlay triggered by selecting a file in the tree.
 */
export function useWorkspacePaneVisibility(): [
  WorkspacePaneVisibilityMap,
  (
    next:
      | WorkspacePaneVisibilityMap
      | ((prev: WorkspacePaneVisibilityMap) => WorkspacePaneVisibilityMap),
  ) => void,
  (paneId: WorkspacePaneId) => void,
] {
  const [visibility, setVisibility] = useLocalStorage<WorkspacePaneVisibilityMap, unknown>(
    VISIBILITY_STORAGE_KEY,
    DEFAULT_VISIBILITY,
    VisibilitySchema as unknown as Schema.Codec<WorkspacePaneVisibilityMap, unknown>,
  );

  const togglePane = useCallback(
    (paneId: WorkspacePaneId) => {
      setVisibility((prev) => {
        const next = { ...prev, [paneId]: !prev[paneId] } satisfies WorkspacePaneVisibilityMap;
        // Don't allow zero visible cards in the stack — keep tree as the
        // anchor so the rail body never goes empty.
        if (!next.tree && !next.recent && !next.task) {
          return { ...next, tree: true };
        }
        return next;
      });
    },
    [setVisibility],
  );

  return [visibility, setVisibility, togglePane];
}

/**
 * Persisted "which cards are collapsed (header-only)" map. Independent of
 * visibility — a card can be visible-but-collapsed (showing its title bar but
 * not its body), like Cowork's right-panel cards.
 */
export function useWorkspacePaneCollapsed(): [
  WorkspacePaneVisibilityMap,
  (paneId: WorkspacePaneId) => void,
] {
  const [collapsed, setCollapsed] = useLocalStorage<WorkspacePaneVisibilityMap, unknown>(
    COLLAPSED_STORAGE_KEY,
    DEFAULT_COLLAPSED,
    CollapsedSchema as unknown as Schema.Codec<WorkspacePaneVisibilityMap, unknown>,
  );

  const togglePaneCollapsed = useCallback(
    (paneId: WorkspacePaneId) => {
      setCollapsed((prev) => ({ ...prev, [paneId]: !prev[paneId] }));
    },
    [setCollapsed],
  );

  return [collapsed, togglePaneCollapsed];
}

export const WORKSPACE_PANE_DEFAULT_VISIBILITY = DEFAULT_VISIBILITY;
export const WORKSPACE_PANE_DEFAULT_COLLAPSED = DEFAULT_COLLAPSED;
