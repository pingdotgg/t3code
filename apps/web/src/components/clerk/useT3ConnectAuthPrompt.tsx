import { useClerk } from "@clerk/react";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    clerk.openSignIn({ forceRedirectUrl: window.location.href });
  };
  return { authPrompt: null, openAuthPrompt };
}
