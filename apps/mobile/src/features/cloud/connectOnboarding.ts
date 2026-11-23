import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { isConnectOnboardingOptedOut } from "./connectOnboardingOptOut";

// Sign-in happens in its own modal; give its session-state transition a beat to
// settle before presenting another formSheet on top.
const PRESENT_ONBOARDING_DELAY_MS = 600;

interface PendingRequest {
  readonly accountId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

// Retain the account id so sign-out cannot present onboarding for the wrong account.
let pending: PendingRequest | null = null;

export function requestConnectOnboarding(accountId: string): void {
  clearConnectOnboardingRequest();
  const request: PendingRequest = {
    accountId,
    timer: setTimeout(() => {
      void (async () => {
        const optedOut = await isConnectOnboardingOptedOut(accountId).catch(() => false);
        // A sign-out or a newer sign-in may have replaced this request while
        // the opt-out read was in flight.
        if (pending !== request) return;
        if (optedOut) {
          pending = null;
          return;
        }
        // Stays pending until navigation is ready, so a sign-out meanwhile still cancels it.
        whenRootNavigationReady(() => {
          if (pending !== request) return;
          pending = null;
          rootNavigationRef.navigate("ConnectOnboarding");
        });
      })();
    }, PRESENT_ONBOARDING_DELAY_MS),
  };
  pending = request;
}

export function clearConnectOnboardingRequest(): void {
  if (pending === null) return;
  clearTimeout(pending.timer);
  pending = null;
}
