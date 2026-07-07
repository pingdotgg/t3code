import { loadPreferences, savePreferencesPatch } from "../../lib/storage";

// Lives apart from connectOnboarding.ts so CloudAuthProvider (which imports
// the request signal) never pulls lib/storage — expo-secure-store — into its
// module graph; that breaks CloudAuthProvider.test.ts suite loading.

/** Whether the account chose "Don't show this again". */
export async function isConnectOnboardingOptedOut(accountId: string): Promise<boolean> {
  const preferences = await loadPreferences();
  return preferences.connectOnboardingOptOutAccounts?.includes(accountId) ?? false;
}

/** Persists "Don't show this again" for the account. */
export async function optOutOfConnectOnboarding(accountId: string): Promise<void> {
  const preferences = await loadPreferences();
  const optedOut = preferences.connectOnboardingOptOutAccounts ?? [];
  if (optedOut.includes(accountId)) {
    return;
  }
  await savePreferencesPatch({ connectOnboardingOptOutAccounts: [...optedOut, accountId] });
}
