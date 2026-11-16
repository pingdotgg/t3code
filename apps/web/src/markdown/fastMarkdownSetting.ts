import * as Schema from "effect/Schema";

import { readLocalStorageValue, writeLocalStorageValue } from "../hooks/useLocalStorage";

const FAST_MARKDOWN_STORAGE_KEY = "t3code:labs:fast-markdown:v1";

/** Read once: renderers and their caches are built for one pipeline, so switching reloads the window. */
export const FAST_MARKDOWN = readLocalStorageValue(
  FAST_MARKDOWN_STORAGE_KEY,
  false,
  Schema.Boolean,
);

export function setFastMarkdown(enabled: boolean): void {
  writeLocalStorageValue(FAST_MARKDOWN_STORAGE_KEY, enabled, false, Schema.Boolean);
  window.location.reload();
}
