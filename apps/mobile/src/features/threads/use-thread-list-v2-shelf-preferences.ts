import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { startTransition } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Field selectors keep a shelf toggle from rebuilding the list again when the disk write
 * confirms the same expanded flags the optimistic patch already applied.
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
  // startTransition keeps the chevron press responsive while the large list insert commits.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    startTransition(() => {
      savePreferences({
        transform: (current) => ({
          threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
        }),
      });
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    startTransition(() => {
      savePreferences({
        transform: (current) => ({
          threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
        }),
      });
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    startTransition(() => {
      savePreferences({
        transform: (current) => ({
          threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
        }),
      });
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
