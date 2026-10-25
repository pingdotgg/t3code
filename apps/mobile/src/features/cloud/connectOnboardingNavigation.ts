import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { clearConnectOnboardingRequest, connectOnboardingRequestAtom } from "./connectOnboarding";
import { isConnectOnboardingOptedOut } from "./connectOnboardingOptOut";

// Sign-in happens in its own modal; give its session-state transition a beat to
// settle before presenting another formSheet on top.
const PRESENT_ONBOARDING_DELAY_MS = 600;

/** Keep @react-navigation out of non-navigation consumers' import graphs. */
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
        // Re-check the request atom: sign-out can clear it before this render commits.
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
