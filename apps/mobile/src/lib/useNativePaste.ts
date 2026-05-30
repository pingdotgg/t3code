import type { PasteEventPayload } from "expo-paste-input";
import { useCallback } from "react";

/**
 * Returns a stable `onPaste` handler for `TextInputWrapper` from
 * `expo-paste-input`.  When the user pastes images via the OS paste gesture,
 * `onImages` is called with the pasted URIs.  Text pastes are left to the
 * native TextInput — no extra handling is needed.
 *
 * Used by both the thread composer and the new-task draft screen.
 */
export function useNativePaste(onImages: (uris: ReadonlyArray<string>) => void) {
  return useCallback(
    (payload: PasteEventPayload) => {
      if (payload.type === "images" && payload.uris && payload.uris.length > 0) {
        onImages(payload.uris);
      }
    },
    [onImages],
  );
}
