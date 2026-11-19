import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const EMPTY_COLLAPSED_PROJECT_KEYS: readonly string[] = [];

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const projectFoldersEnabled =
    loaded && preferencesResult.value.threadListProjectFoldersEnabled === true;
  const workingShelfEnabled =
    loaded && preferencesResult.value.workingShelfEnabled !== false && !projectFoldersEnabled;
  const activeReorderEnabled = loaded && !workingShelfEnabled && !projectFoldersEnabled;
  const collapsedProjectKeys = loaded
    ? (preferencesResult.value.collapsedProjectGroups ?? EMPTY_COLLAPSED_PROJECT_KEYS)
    : EMPTY_COLLAPSED_PROJECT_KEYS;
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
  const toggleProjectFolder = (projectKey: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.collapsedProjectGroups ?? EMPTY_COLLAPSED_PROJECT_KEYS;
        return {
          collapsedProjectGroups: collapsed.includes(projectKey)
            ? collapsed.filter((key) => key !== projectKey)
            : [...collapsed, projectKey],
        };
      },
    });
  };

  return {
    loaded,
    projectFoldersEnabled,
    collapsedProjectKeys,
    activeReorderEnabled,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    toggleProjectFolder,
  } as const;
}
