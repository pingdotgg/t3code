import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

const PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY = "t3code:provider-update-dismissals:v1";

const ProviderUpdateDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

export function useDismissedProviderUpdateNotificationKeys() {
  const [dismissals, setDismissals] = useLocalStorage(
    PROVIDER_UPDATE_DISMISSALS_STORAGE_KEY,
    { keys: [] },
    ProviderUpdateDismissalsSchema,
  );
  const dismissedKeys = dismissals.keys;

  const dismissedKeySet = useMemo(() => new Set(dismissedKeys), [dismissedKeys]);

  // Takes every key being declined in one call: each call writes from the same
  // render's snapshot, so dismissing keys one at a time would keep only the last.
  const dismissNotificationKey = useCallback(
    (...keys: ReadonlyArray<string>) => {
      const newKeys = keys
        .map((key) => key.trim())
        .filter((key) => key.length > 0 && !dismissedKeySet.has(key));
      if (newKeys.length === 0) {
        return;
      }

      setDismissals({
        keys: [...dismissedKeys, ...new Set(newKeys)],
      });
    },
    [dismissedKeySet, dismissedKeys, setDismissals],
  );

  return {
    dismissedNotificationKeys: dismissedKeySet,
    dismissNotificationKey,
  };
}
