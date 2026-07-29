import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { authPrompt: null, openAuthPrompt };
}
