import { SIGNED_OUT_CLOUD_AUTH, type CloudAuthState } from "@t3tools/client-runtime/relay";
import { createContext, useContext } from "react";

/** Screens read this instead of a provider's own hooks. */
export interface CloudAuth extends CloudAuthState {
  readonly signOut: () => Promise<void>;
}

const SIGNED_OUT: CloudAuth = { ...SIGNED_OUT_CLOUD_AUTH, signOut: async () => {} };

export const CloudAuthContext = createContext<CloudAuth>(SIGNED_OUT);

export const useCloudAuth = (): CloudAuth => useContext(CloudAuthContext);
