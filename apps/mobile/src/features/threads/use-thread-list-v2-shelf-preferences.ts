import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

// Pipelines start collapsed, so only the latest expansions are worth keeping.
const MAX_EXPANDED_PIPELINES = 200;
const NO_EXPANDED_PIPELINES: readonly string[] = [];

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled !== false;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const expandedPipelineKeys =
    (loaded ? preferencesResult.value.threadListExpandedPipelines : undefined) ??
    NO_EXPANDED_PIPELINES;

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
  const togglePipelineExpanded = (threadKey: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const keys = current.threadListExpandedPipelines ?? [];
        return {
          threadListExpandedPipelines: keys.includes(threadKey)
            ? keys.filter((key) => key !== threadKey)
            : [...keys, threadKey].slice(-MAX_EXPANDED_PIPELINES),
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
    expandedPipelineKeys,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
    togglePipelineExpanded,
  } as const;
}
