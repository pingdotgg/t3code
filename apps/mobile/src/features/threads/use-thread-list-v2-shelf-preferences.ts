import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const boringSidebarEnabled = loaded && preferencesResult.value.boringSidebarEnabled === true;
  const workingShelfEnabled =
    loaded && !boringSidebarEnabled && preferencesResult.value.workingShelfEnabled !== false;
  const collapsed = loaded ? preferencesResult.value.collapsedProjectGroups : undefined;
  const collapsedProjectKeys = useMemo(() => new Set(collapsed), [collapsed]);
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };
  const toggleProjectFolder = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.collapsedProjectGroups ?? [];
        return {
          collapsedProjectGroups: collapsed.includes(key)
            ? collapsed.filter((entry) => entry !== key)
            : [...collapsed, key],
        };
      },
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    boringSidebarEnabled,
    collapsedProjectKeys,
    toggleProjectFolder,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
