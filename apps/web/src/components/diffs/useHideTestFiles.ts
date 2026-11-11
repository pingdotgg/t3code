import * as Schema from "effect/Schema";
import { compileDiffHideFilePatterns, matchesDiffHideFile } from "@t3tools/shared/changedFileKind";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";

const HIDE_TEST_FILES_STORAGE_KEY = "t3code.diffHideTestFiles";

export function useHideTestFiles() {
  const [hideTestFiles, setHideTestFiles] = useLocalStorage(
    HIDE_TEST_FILES_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const source = useClientSettings((settings) => settings.diffHideFilePatterns);
  const { patterns } = compileDiffHideFilePatterns(source);
  return {
    hideTestFiles,
    setHideTestFiles,
    matchesHiddenFile: (path: string) => matchesDiffHideFile(path, patterns),
    fileLabel: patterns.length > 0 ? "matching" : "test",
  };
}
