import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const projectFolderPreferences =
    loaded && preferencesResult.value.boringSidebarEnabled === true
      ? {
          collapsedKeys: preferencesResult.value.collapsedProjectGroups ?? [],
          multiline: preferencesResult.value.boringSidebarMultilineRows === true,
        }
      : null;
  const workingShelfEnabled =
    projectFolderPreferences === null &&
    loaded &&
    preferencesResult.value.workingShelfEnabled !== false;
  const toggleProjectFolder = (key: string) => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => {
        const collapsedKeys = current.collapsedProjectGroups ?? [];
        return {
          collapsedProjectGroups: collapsedKeys.includes(key)
            ? collapsedKeys.filter((collapsedKey) => collapsedKey !== key)
            : [...collapsedKeys, key],
        };
      },
    });
  };
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    void savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  return {
    loaded,
    projectFolderPreferences,
    toggleProjectFolder,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}
