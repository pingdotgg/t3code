import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../state/preferences";

/**
 * Paste size at which the composer folds clipboard text into a text-file
 * attachment. Selects only the threshold so unrelated preference writes do not
 * re-render the composer editors.
 */
export function usePastedTextAttachmentThreshold() {
  return useAtomValue(mobilePreferencesAtom, (preferences) =>
    AsyncResult.isSuccess(preferences)
      ? (preferences.value.pastedTextAttachmentThreshold ??
        DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD)
      : DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  );
}
