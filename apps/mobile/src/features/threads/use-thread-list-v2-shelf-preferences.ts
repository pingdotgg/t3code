import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Field selectors skip the disk-confirm rebuild. Toggles stay urgent for the chevron; Home and
 * the sidebar defer the expanded flags into the list so row insert/remove miss the press frame.
 */
export function useThreadListV2ShelfPreferences() {
  const loaded = useAtomValue(mobilePreferencesAtom, AsyncResult.isSuccess);
  const snoozedShelfExpanded = useAtomValue(
    mobilePreferencesAtom,
    (result) =>
      AsyncResult.isSuccess(result) && result.value.threadListSnoozedShelfExpanded === true,
  );
  const settledShelfExpanded = useAtomValue(
    mobilePreferencesAtom,
    (result) =>
      AsyncResult.isSuccess(result) && result.value.threadListSettledShelfExpanded === true,
  );
  const workingShelfEnabled = useAtomValue(
    mobilePreferencesAtom,
    (result) => AsyncResult.isSuccess(result) && result.value.workingShelfEnabled !== false,
  );
  const workingShelfExpanded = useAtomValue(
    mobilePreferencesAtom,
    (result) =>
      AsyncResult.isSuccess(result) && result.value.threadListWorkingShelfExpanded === true,
  );
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);

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

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
