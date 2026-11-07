import { SIGNED_OUT_CLOUD_AUTH, type CloudAuthState } from "@t3tools/client-runtime/relay";
import { createContext, useContext, type ReactNode } from "react";

import type { T3ConnectAccountPageUrl } from "../components/clerk/T3ConnectAccountPages";

/** Components read this instead of a provider's own hooks. */
export interface CloudAuth extends CloudAuthState {
  readonly signIn: () => void;
  readonly signOut: () => Promise<void>;
  /**
   * Also true for a Clerk session with steps still pending. Activation uses it so that such a
   * session does not look like a fresh sign-in once it completes.
   */
  readonly hasSession: boolean;
  /** Clerk's account pages; null for providers that do not host any. */
  readonly openAccount: ((page?: T3ConnectAccountPageUrl) => void) | null;
}

const SIGNED_OUT: CloudAuth = {
  ...SIGNED_OUT_CLOUD_AUTH,
  signIn: () => {},
  signOut: async () => {},
  hasSession: false,
  openAccount: null,
};

const CloudAuthContext = createContext<CloudAuth>(SIGNED_OUT);

export function CloudAuthProvider({
  value,
  children,
}: {
  readonly value: CloudAuth;
  readonly children: ReactNode;
}) {
  return <CloudAuthContext.Provider value={value}>{children}</CloudAuthContext.Provider>;
}

export const useCloudAuth = (): CloudAuth => useContext(CloudAuthContext);

/** Opens the provider's account pages. Their content is rendered once by the provider itself. */
export function useT3ConnectAccountPage(): {
  readonly open: CloudAuth["openAccount"];
  readonly portals: ReactNode;
} {
  return { open: useCloudAuth().openAccount, portals: null };
}
