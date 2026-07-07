import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

// Signals RootStackLayout (inside the navigation tree) that an in-session
// sign-in just completed. Holds the account id so a sign-out between the
// request and the navigation cannot present the sheet for the wrong account.
export const connectOnboardingRequestAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connect-onboarding-request"),
);

/**
 * Requests the onboarding sheet for the given account. Sign-out clears the
 * connected environments, so onboarding runs on every in-session sign-in —
 * each new session starts with no connected devices.
 */
export function requestConnectOnboarding(accountId: string): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, accountId);
}

export function clearConnectOnboardingRequest(): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, null);
}
