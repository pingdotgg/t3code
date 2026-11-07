import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const HIDE_DOCUMENTATION_FILES_STORAGE_KEY = "t3code.diffHideDocumentationFiles";

export function useHideDocumentationFiles() {
  return useLocalStorage(HIDE_DOCUMENTATION_FILES_STORAGE_KEY, false, Schema.Boolean);
}
