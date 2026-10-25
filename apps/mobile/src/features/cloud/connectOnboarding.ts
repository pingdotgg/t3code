import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

// Retain the account id so sign-out cannot present onboarding for the wrong account.
export const connectOnboardingRequestAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connect-onboarding-request"),
);

export function requestConnectOnboarding(accountId: string): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, accountId);
}

export function clearConnectOnboardingRequest(): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, null);
}
