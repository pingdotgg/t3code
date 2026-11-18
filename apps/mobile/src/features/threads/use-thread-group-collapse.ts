import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const PREFIX = "thread-group:";

/** Collapsed thread groups, saved on this device in the existing collapsedProjectGroups preference. */
export function useThreadGroupCollapse(): {
  readonly loaded: boolean;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly toggleGroup: (leadKey: string) => void;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const signature = loaded
    ? (preferencesResult.value.collapsedProjectGroups ?? [])
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => key.slice(PREFIX.length))
        .sort()
        .join("\n")
    : "";
  // Stable identity while contents are unchanged: list items compare by content.
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => new Set(signature === "" ? [] : signature.split("\n")),
    [signature],
  );

  const toggleGroup = (leadKey: string) => {
    if (!loaded) return;
    const key = PREFIX + leadKey;
    // Transforms read optimistic state so same-frame presses toggle twice.
    savePreferences({
      transform: (current) => {
        const keys = current.collapsedProjectGroups ?? [];
        return {
          collapsedProjectGroups: keys.includes(key)
            ? keys.filter((entry) => entry !== key)
            : [...keys, key],
        };
      },
    });
  };

  return { loaded, collapsedKeys, toggleGroup };
}
