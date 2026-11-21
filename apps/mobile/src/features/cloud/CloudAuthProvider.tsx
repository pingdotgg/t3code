import { ClerkProvider, getClerkInstance, useAuth, useUser } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import type { OidcController } from "@t3tools/client-runtime/relay";
import { type ReactNode, useSyncExternalStore } from "react";

import {
  cloudAccountService,
  createCloudRelayAccountService,
  deactivateCloudRelayAccount,
} from "./cloudAccountService";
import { CloudAuthContext, type CloudAuth } from "./cloudAuth";
import { getMobileOidcController } from "./oidc/mobileOidc";
import {
  cloudAuthProvider,
  resolveCloudPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
const provider = cloudAuthProvider(cloudConfig);
const oidcController = provider === "oidc" ? getMobileOidcController() : null;
// Build-time constant: null when this build has no Clerk config, or uses an OIDC provider instead.
const publishableKey =
  provider !== "oidc" && cloudConfig.relay.url ? cloudConfig.clerk.publishableKey : null;

if (oidcController) {
  // The ID token is what the relay verifies, so that is the token the account service hands out.
  createCloudRelayAccountService<OidcController>((source) => source.getToken).attach(
    oidcController,
  );
} else if (publishableKey) {
  // The same native singleton ClerkProvider renders with, so the service
  // observes it for the app's lifetime without a React subscription.
  cloudAccountService.attach(getClerkInstance({ publishableKey }));
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

function OidcAuthBridge(props: {
  readonly controller: OidcController;
  readonly children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot);
  const value: CloudAuth = {
    provider: "oidc",
    isLoaded: true,
    isSignedIn: snapshot.userId !== null,
    userId: snapshot.userId,
    accountLabel: snapshot.label,
    getToken: props.controller.getToken,
    signOut: props.controller.signOut,
  };
  return <CloudAuthContext.Provider value={value}>{props.children}</CloudAuthContext.Provider>;
}

function ClerkAuthBridge(props: { readonly children: ReactNode }) {
  // A session with steps pending must not look signed out, or activation would look like a new sign-in.
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { user } = useUser();
  const value: CloudAuth = {
    provider: "clerk",
    isLoaded,
    isSignedIn: isSignedIn === true,
    userId: userId ?? null,
    accountLabel: user?.primaryEmailAddress?.emailAddress ?? null,
    getToken: () => getToken(resolveRelayClerkTokenOptions()),
    signOut: () => signOut(),
  };
  return <CloudAuthContext.Provider value={value}>{props.children}</CloudAuthContext.Provider>;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (oidcController) {
    return <OidcAuthBridge controller={oidcController}>{props.children}</OidcAuthBridge>;
  }
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkAuthBridge>{props.children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}
