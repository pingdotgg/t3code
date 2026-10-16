import type { PasteEventPayload } from "expo-paste-input";
import { useCallback } from "react";

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
