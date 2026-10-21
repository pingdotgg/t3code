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

  const dismissedKeySet = new Set(dismissedKeys);

  const dismissNotificationKey = (key: string) => {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0 || dismissedKeySet.has(trimmedKey)) {
      return;
    }

    setDismissals({
      keys: [...dismissedKeys, trimmedKey],
    });
  };

  return {
    dismissedNotificationKeys: dismissedKeySet,
    dismissNotificationKey,
  };
}
