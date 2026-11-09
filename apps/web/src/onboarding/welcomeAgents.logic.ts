import type { ServerProvider } from "@t3tools/contracts";

import { getOnboardingProviderState } from "./providerReadiness.logic";

// Ready agents first, then ones that need a sign-in or a look. Never ranked by vendor.
const FOUND_ORDER = { ready: 0, signIn: 1, attention: 2 } as const;
type FoundState = keyof typeof FOUND_ORDER;

const isFoundState = (state: string): state is FoundState => state in FOUND_ORDER;

/**
 * Splits a computer's providers into agents already on it and agents the user can add.
 * Order inside each group is by state, then by the name the user sees.
 */
export function groupWelcomeAgents(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  nameOf: (provider: ServerProvider) => string,
) {
  const found: ServerProvider[] = [];
  const available: ServerProvider[] = [];
  let checking = providers == null;
  for (const provider of providers ?? []) {
    const state = getOnboardingProviderState(provider);
    if (state === "checking") checking = true;
    else if (isFoundState(state)) found.push(provider);
    else available.push(provider);
  }
  const byName = (a: ServerProvider, b: ServerProvider) => nameOf(a).localeCompare(nameOf(b));
  const foundRank = (provider: ServerProvider) => {
    const state = getOnboardingProviderState(provider);
    return isFoundState(state) ? FOUND_ORDER[state] : FOUND_ORDER.attention;
  };
  found.sort((a, b) => foundRank(a) - foundRank(b) || byName(a, b));
  available.sort(byName);
  return { checking, found, available };
}
