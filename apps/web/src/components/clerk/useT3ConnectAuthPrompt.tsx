import { useClerk } from "@clerk/react";
import { useCallback } from "react";

import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = useCallback(() => {
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  }, [clerk]);
  return { authPrompt: null, openAuthPrompt };
}
