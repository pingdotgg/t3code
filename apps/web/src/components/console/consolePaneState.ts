import { Schema } from "effect";
import { useCallback } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";

import type { ConsolePaneId, ConsolePaneVisibilityMap } from "./consoleTypes";

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

const DEFAULT_VISIBILITY: ConsolePaneVisibilityMap = {
  // The Console should immediately surface the three core panes users rely
  // on most: files, recent edited files, and tasks.
  tree: true,
  recent: true,
  task: true,
};

const DEFAULT_COLLAPSED: ConsolePaneVisibilityMap = {
  tree: false,
  recent: false,
  task: false,
};

/**
 * Persisted "which cards are visible in the stack" map. The viewer is
 * intentionally not in this map — it's not a stack card, it's the takeover
 * overlay triggered by selecting a file in the tree.
 */
export function useConsolePaneVisibility(): [
  ConsolePaneVisibilityMap,
  (
    next:
      | ConsolePaneVisibilityMap
      | ((prev: ConsolePaneVisibilityMap) => ConsolePaneVisibilityMap),
  ) => void,
  (paneId: ConsolePaneId) => void,
] {
  const [visibility, setVisibility] = useLocalStorage<ConsolePaneVisibilityMap, unknown>(
    VISIBILITY_STORAGE_KEY,
    DEFAULT_VISIBILITY,
    VisibilitySchema as unknown as Schema.Codec<ConsolePaneVisibilityMap, unknown>,
  );

  const togglePane = useCallback(
    (paneId: ConsolePaneId) => {
      setVisibility((prev) => {
        const next = { ...prev, [paneId]: !prev[paneId] } satisfies ConsolePaneVisibilityMap;
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
export function useConsolePaneCollapsed(): [
  ConsolePaneVisibilityMap,
  (paneId: ConsolePaneId) => void,
] {
  const [collapsed, setCollapsed] = useLocalStorage<ConsolePaneVisibilityMap, unknown>(
    COLLAPSED_STORAGE_KEY,
    DEFAULT_COLLAPSED,
    CollapsedSchema as unknown as Schema.Codec<ConsolePaneVisibilityMap, unknown>,
  );

  const togglePaneCollapsed = useCallback(
    (paneId: ConsolePaneId) => {
      setCollapsed((prev) => ({ ...prev, [paneId]: !prev[paneId] }));
    },
    [setCollapsed],
  );

  return [collapsed, togglePaneCollapsed];
}

export const CONSOLE_PANE_DEFAULT_VISIBILITY = DEFAULT_VISIBILITY;
export const CONSOLE_PANE_DEFAULT_COLLAPSED = DEFAULT_COLLAPSED;
