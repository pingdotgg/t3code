import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  // Pins stay listed until the stored choice says otherwise, so they do not pop in after loading.
  const pinnedShelfExpanded =
    !loaded || preferencesResult.value.threadListPinnedShelfExpanded !== false;
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const togglePinnedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListPinnedShelfExpanded: current.threadListPinnedShelfExpanded === false,
      }),
    });
  };
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

  return {
    loaded,
    pinnedShelfExpanded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    togglePinnedShelf,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
