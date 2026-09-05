import { useClerk } from "@clerk/react";

import { markConnectOnboardingAuthPending } from "../../cloud/connectOnboarding";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    markConnectOnboardingAuthPending();
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { authPrompt: null, openAuthPrompt };
}
