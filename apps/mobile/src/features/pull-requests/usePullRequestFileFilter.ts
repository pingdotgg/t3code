import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import type { ReviewParsedDiff } from "../review/reviewModel";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  filterPullRequestTestFiles,
  filterPullRequestViewedFiles,
  viewedFilePaths,
} from "./pullRequestFileFilters";
import type { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";

const PATH_SEPARATOR = "\0";

export function usePullRequestFileFilter(
  parsed: ReviewParsedDiff,
  viewed: ReturnType<typeof usePullRequestFilesViewed>,
  includePath?: string,
  keptPaths: readonly string[] = [],
) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const hideTestFiles = saved?.pullRequestHideTestFiles === true;
  const hideViewedFiles = viewed.supported && saved?.pullRequestHideViewedFiles === true;
  const withoutTests = useMemo(
    () => filterPullRequestTestFiles(parsed, hideTestFiles, includePath),
    [parsed, hideTestFiles, includePath],
  );
  const { viewed: viewedPaths, hidden } = viewedFilePaths(
    withoutTests,
    (path) => viewed.supported && viewed.isViewed(path),
    // Files marked here stay until the screen closes, so marking one never pulls it out from under you.
    (path) => path === includePath || keptPaths.includes(path) || viewed.toggledHere(path),
  );
  const hiddenViewedPaths = hideViewedFiles ? hidden : [];
  // A string key keeps the same diff object while the hidden set holds, so native rows aren't rebuilt.
  const hiddenViewedKey = hiddenViewedPaths.join(PATH_SEPARATOR);
  const visible = useMemo(
    () =>
      hiddenViewedKey
        ? filterPullRequestViewedFiles(withoutTests, new Set(hiddenViewedKey.split(PATH_SEPARATOR)))
        : withoutTests,
    [withoutTests, hiddenViewedKey],
  );
  const hiddenCount =
    parsed.kind === "files" && withoutTests.kind === "files"
      ? parsed.fileCount - withoutTests.fileCount
      : 0;
  return {
    parsed: visible,
    hideTestFiles,
    hiddenCount,
    toggle: () => {
      void savePreferences({ pullRequestHideTestFiles: !hideTestFiles });
    },
    showAll: () => {
      void savePreferences({ pullRequestHideTestFiles: false });
    },
    hideViewedFiles,
    viewedCount: viewedPaths.length,
    hiddenViewedCount: hiddenViewedPaths.length,
    canHideViewedFiles: viewed.supported && (viewedPaths.length > 0 || hideViewedFiles),
    toggleViewedFiles: () => {
      void savePreferences({ pullRequestHideViewedFiles: !hideViewedFiles });
    },
    showViewedFiles: () => {
      void savePreferences({ pullRequestHideViewedFiles: false });
    },
  };
}
