import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { filterPullRequestFiles } from "./pullRequestFileFilters";

export function usePullRequestFileFilter(parsed: ReviewParsedDiff, includePath?: string) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const hideTestFiles =
    AsyncResult.isSuccess(preferences) && preferences.value.pullRequestHideTestFiles === true;
  const hideDocumentationFiles =
    AsyncResult.isSuccess(preferences) &&
    preferences.value.pullRequestHideDocumentationFiles === true;
  const visible = useMemo(
    () =>
      filterPullRequestFiles(parsed, {
        hideTestFiles,
        hideDocumentationFiles,
        includePath,
      }),
    [parsed, hideTestFiles, hideDocumentationFiles, includePath],
  );
  const hiddenCount =
    parsed.kind === "files" && visible.kind === "files" ? parsed.fileCount - visible.fileCount : 0;
  return {
    parsed: visible,
    hideTestFiles,
    hideDocumentationFiles,
    hiddenCount,
    toggleTests: () => savePreferences({ pullRequestHideTestFiles: !hideTestFiles }),
    toggleDocumentation: () =>
      savePreferences({ pullRequestHideDocumentationFiles: !hideDocumentationFiles }),
    showAll: () =>
      savePreferences({
        pullRequestHideTestFiles: false,
        pullRequestHideDocumentationFiles: false,
      }),
  };
}
