import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { filterPullRequestTestFiles } from "./pullRequestFileFilters";

export function useHideTestFilesPreference() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hideTestFiles =
    AsyncResult.isSuccess(preferences) && preferences.value.pullRequestHideTestFiles === true;
  return {
    hideTestFiles,
    toggle: () => savePreferences({ pullRequestHideTestFiles: !hideTestFiles }),
    showAll: () => savePreferences({ pullRequestHideTestFiles: false }),
  };
}

export function usePullRequestFileFilter(parsed: ReviewParsedDiff, includePath?: string) {
  const preference = useHideTestFilesPreference();
  const { hideTestFiles } = preference;
  const visible = useMemo(
    () => filterPullRequestTestFiles(parsed, hideTestFiles, includePath),
    [parsed, hideTestFiles, includePath],
  );
  const hiddenCount =
    parsed.kind === "files" && visible.kind === "files" ? parsed.fileCount - visible.fileCount : 0;
  return { ...preference, parsed: visible, hiddenCount };
}
