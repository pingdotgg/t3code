import { useCallback } from "react";

import { useUpdateClientSettings } from "../hooks/useSettings";

/**
 * Marks first-run onboarding finished (or skipped) so FirstRunGate never
 * routes to the welcome wizard again. The gate itself lives in
 * `components/onboarding/FirstRunGate.tsx`.
 */
export function useCompleteOnboarding(): () => void {
  const updateClientSettings = useUpdateClientSettings();
  return useCallback(() => {
    updateClientSettings({ onboardingCompletedAt: new Date().toISOString() });
  }, [updateClientSettings]);
}
