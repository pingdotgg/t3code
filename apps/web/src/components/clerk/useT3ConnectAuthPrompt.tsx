import { useCloudAuth } from "../../cloud/cloudAuth";

export function useT3ConnectAuthPrompt() {
  const { signIn } = useCloudAuth();
  return { openAuthPrompt: signIn };
}
