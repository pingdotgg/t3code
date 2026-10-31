import * as Schema from "effect/Schema";

import { setLocalStorageItem } from "../hooks/useLocalStorage";
import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";

export const SETUP_COMPLETED_KEY = "t3code:setup-completed:v1";

export async function completeOnboarding(): Promise<void> {
  await ensureClientSettingsHydrated();
  const onboardingCompletedAt = new Date().toISOString();
  await persistClientSettingsUpdate((current) => ({ ...current, onboardingCompletedAt }));
  try {
    setLocalStorageItem(SETUP_COMPLETED_KEY, true, Schema.Boolean);
  } catch {
    // The persisted client setting already records completion; this marker is optional.
  }
}
