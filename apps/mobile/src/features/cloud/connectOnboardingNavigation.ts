import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { clearConnectOnboardingRequest, connectOnboardingRequestAtom } from "./connectOnboarding";
import { isConnectOnboardingOptedOut } from "./connectOnboardingOptOut";

// Sign-in happens in its own modal; give its session-state transition a beat to
// settle before presenting another formSheet on top.
const PRESENT_ONBOARDING_DELAY_MS = 600;

/**
 * Lives apart from connectOnboarding.ts so non-navigation consumers
 * (CloudAuthProvider) do not pull
 * @react-navigation into their module graph.
 */
export function useConnectOnboardingNavigation(): void {
  const navigation = useNavigation();
  const requestedAccountId = useAtomValue(connectOnboardingRequestAtom);

  useEffect(() => {
    if (requestedAccountId === null) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const optedOut = await isConnectOnboardingOptedOut(requestedAccountId).catch(() => false);
        // The cancelled flag covers effect re-runs, but a sign-out can clear
        // the request atom moments before this render commits — re-check the
        // atom so a stale request never presents the sheet.
        if (cancelled || appAtomRegistry.get(connectOnboardingRequestAtom) !== requestedAccountId) {
          return;
        }
        clearConnectOnboardingRequest();
        if (!optedOut) {
          navigation.navigate("ConnectOnboarding");
        }
      })();
    }, PRESENT_ONBOARDING_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [navigation, requestedAccountId]);
}
