import { useAuth, useClerk } from "@clerk/react";
import { useCallback, type ReactNode } from "react";

import { ConnectAuthProvider } from "../../cloud/connectAuth";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";
import { useClerkT3ConnectAccountPage } from "./T3ConnectAccountPages";

export function ClerkConnectAuthProvider({ children }: { readonly children: ReactNode }) {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  const clerk = useClerk();
  const account = useClerkT3ConnectAccountPage();
  const { getToken: getClerkToken } = auth;
  const getToken = useCallback(
    () => getClerkToken(resolveRelayClerkTokenOptions()),
    [getClerkToken],
  );
  return (
    <ConnectAuthProvider
      value={{
        mode: "clerk",
        canSignIn: true,
        isLoaded: auth.isLoaded,
        isSignedIn: !!auth.isSignedIn,
        userId: auth.userId ?? null,
        identity: null,
        getToken,
        openSignIn: () =>
          clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron)),
        signOut: () => clerk.signOut(),
        openAccount: (page) => account.open?.(page),
      }}
    >
      {children}
      {account.portals}
    </ConnectAuthProvider>
  );
}
