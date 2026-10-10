import * as Schema from "effect/Schema";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Accounts that opted out of the post-sign-in T3 Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

/**
 * The Clerk account as the managed-auth shell sees it. The shell provides it
 * so startup code can follow sign-ins without importing Clerk. Null when no
 * shell is mounted.
 */
export interface ManagedAccountState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly userId: string | null | undefined;
}

export const ManagedAccountContext = createContext<ManagedAccountState | null>(null);

/**
 * The account whose sign-in should open the onboarding wizard. Every sign-in
 * or account switch that completes while this is mounted requests it, since
 * account transitions clear the connected relay environments. A cold load
 * observes undefined → account and must not re-prompt. The wizard loads
 * lazily, so this runs eagerly where it mounts and the wizard takes the
 * request whenever its chunk arrives.
 */
export function useConnectOnboardingRequest() {
  const account = useContext(ManagedAccountContext);
  const isLoaded = account?.isLoaded ?? false;
  const isSignedIn = account?.isSignedIn;
  const userId = account?.userId;
  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    // A loaded-but-incomplete snapshot (signed in, user id not yet populated)
    // must not be recorded as signed-out — the next render would then look
    // like a fresh sign-in on a cold load.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount !== undefined && previousAccount !== nextAccount && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  const clearRequestedAccount = useCallback(() => setRequestedAccount(null), []);
  return { requestedAccount, clearRequestedAccount };
}

export type ConnectOnboardingRequest = ReturnType<typeof useConnectOnboardingRequest>;
