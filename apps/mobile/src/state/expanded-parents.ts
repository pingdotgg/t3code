import { useAtomValue } from "@effect/atom-react";
import { toggleExpandedParentKey } from "@t3tools/client-runtime/state/child-status-counts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { mobilePreferencesAtom, saveMobilePreferences } from "./preferences";
import { useAtomCommand } from "./use-atom-command";

const NO_EXPANDED_PARENTS: readonly string[] = [];

/**
 * Parents whose child chats are open, saved on this device and shared by the
 * Agents board and the thread sidebar. All other parents start collapsed.
 */
export function useExpandedParents() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const stored = AsyncResult.isSuccess(preferences)
    ? (preferences.value.expandedParentKeys ?? NO_EXPANDED_PARENTS)
    : NO_EXPANDED_PARENTS;
  const expanded = useMemo(() => new Set(stored), [stored]);
  // Transforms read optimistic state, so same-frame taps toggle twice.
  const toggle = useCallback(
    (parentKey: string) =>
      savePreferences({
        transform: (current) => ({
          expandedParentKeys: toggleExpandedParentKey(
            current.expandedParentKeys ?? NO_EXPANDED_PARENTS,
            parentKey,
          ),
        }),
      }),
    [savePreferences],
  );
  return { expanded, toggle } as const;
}
