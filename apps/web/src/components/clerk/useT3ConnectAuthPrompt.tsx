import { useCloudAuth } from "../../cloud/cloudAuth";
import { retryClerkLoad } from "./clerkLoadFailure";

export function useT3ConnectAuthPrompt() {
  const { signIn, loadFailed } = useCloudAuth();
  return { openAuthPrompt: loadFailed ? retryClerkLoad : signIn };
}
