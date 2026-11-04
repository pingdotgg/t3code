import { useConnectAuth } from "../../cloud/connectAuth";

export function useT3ConnectAuthPrompt() {
  const auth = useConnectAuth();
  return { authPrompt: null, openAuthPrompt: auth.openSignIn };
}
