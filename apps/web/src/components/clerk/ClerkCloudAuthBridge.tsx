import { useAuth, useClerk } from "@clerk/react";
import type { ReactNode } from "react";

import { CloudAuthProvider, type CloudAuth } from "../../cloud/cloudAuth";
import { resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { isElectron } from "../../env";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resolveClerkSignInProps } from "./authRedirect";
import { useClerkLoadFailed } from "./clerkLoadFailure";
import { useClerkAccountPage } from "./T3ConnectAccountPages";

/** Presents Clerk through the provider-neutral `CloudAuth` the rest of the app reads. */
export function ClerkCloudAuthBridge({ children }: { readonly children: ReactNode }) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { userId, isSignedIn: hasSession } = useAuth({ treatPendingAsSignedOut: false });
  const accountPage = useClerkAccountPage();
  const loadFailed = useClerkLoadFailed();

  const value: CloudAuth = {
    provider: "clerk",
    isLoaded,
    isSignedIn: isSignedIn === true,
    hasSession: hasSession === true,
    loadFailed,
    userId: userId ?? null,
    accountLabel: clerk.user?.primaryEmailAddress?.emailAddress ?? null,
    getToken: () => getToken(resolveRelayClerkTokenOptions()),
    signIn: () => {
      clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
    },
    signOut: () => clerk.signOut(),
    openAccount: accountPage.open,
  };

  return (
    <CloudAuthProvider value={value}>
      {children}
      {/* This bridge wraps the app root, so the account pages need the app's atom registry. */}
      <AppAtomRegistryProvider>{accountPage.portals}</AppAtomRegistryProvider>
    </CloudAuthProvider>
  );
}
