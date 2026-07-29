import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkAuthRedirectUrl } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openSignIn({
      forceRedirectUrl: resolveClerkAuthRedirectUrl(window.location.href, isElectron),
    });
  };
  return { authPrompt: null, openAuthPrompt };
}
