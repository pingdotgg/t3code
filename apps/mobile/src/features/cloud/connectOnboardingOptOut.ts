import { loadPreferences, updatePreferences } from "../../persistence/imperative";

// Keep persistence out of CloudAuthProvider's import graph; it breaks suite loading.

export async function isConnectOnboardingOptedOut(accountId: string): Promise<boolean> {
  const preferences = await loadPreferences();
  return preferences.connectOnboardingOptOutAccounts?.includes(accountId) ?? false;
}

export async function optOutOfConnectOnboarding(accountId: string): Promise<void> {
  await updatePreferences((current) => {
    const optedOut = current.connectOnboardingOptOutAccounts ?? [];
    return optedOut.includes(accountId)
      ? {}
      : { connectOnboardingOptOutAccounts: [...optedOut, accountId] };
  });
}
