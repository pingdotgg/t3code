import type { NavigationState } from "@react-navigation/native";

import { loadPreferences, savePreferencesPatch } from "../../persistence/imperative";
import { linearLocationFromStack, type StoredLinearLocation } from "./linearResume";

// Memory is the source while the app runs; storage only carries it across a restart.
let location: StoredLinearLocation | null = null;
// Set by any record or clear, so a cold-start deep link is not overwritten by the saved location.
let changedThisSession = false;
let hydration: Promise<void> | null = null;

function persist() {
  changedThisSession = true;
  void savePreferencesPatch({ linearLocation: location ?? undefined }).catch(() => undefined);
}

/** Loads the saved location once; anything recorded or cleared before it resolves wins. */
export function hydrateLinearLocation(): Promise<void> {
  hydration ??= loadPreferences()
    .then((preferences) => {
      if (!changedThisSession) location = preferences.linearLocation ?? null;
    })
    .catch(() => undefined);
  return hydration;
}

export function currentLinearLocation(): StoredLinearLocation | null {
  return location;
}

/** Navigation container `onStateChange`: remembers the Linear screens while one is focused. */
export function recordLinearLocation(state: NavigationState | undefined): void {
  if (!state) return;
  const next = linearLocationFromStack(state.routes.slice(0, state.index + 1));
  if (next === null) return;
  const organizationId =
    location?.environmentId === next.environmentId ? location.organizationId : null;
  const merged = { ...next, organizationId };
  if (JSON.stringify(merged) === JSON.stringify(location)) return;
  location = merged;
  persist();
}

export function setLinearLocationOrganization(environmentId: string, organizationId: string): void {
  if (location === null || location.environmentId !== environmentId) return;
  if (location.organizationId === organizationId) return;
  location = { ...location, organizationId };
  persist();
}

export function clearLinearLocation(): void {
  location = null;
  persist();
}
