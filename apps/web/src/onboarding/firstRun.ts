import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../hooks/useSettings";

async function completeOnboarding(): Promise<void> {
  await ensureClientSettingsHydrated();
  const onboardingCompletedAt = new Date().toISOString();
  await persistClientSettingsUpdate((current) => ({ ...current, onboardingCompletedAt }));
}

export function useCompleteOnboarding(): () => Promise<void> {
  return completeOnboarding;
}
