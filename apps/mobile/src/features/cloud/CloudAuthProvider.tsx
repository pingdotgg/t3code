import { ClerkProvider, getClerkInstance } from "@clerk/expo";
import { resourceCache } from "@clerk/expo/resource-cache";
import { tokenCache } from "@clerk/expo/token-cache";
import type { ReactNode } from "react";

import { cloudAccountService, deactivateCloudRelayAccount } from "./cloudAccountService";
import { resolveCloudPublicConfig } from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = cloudConfig.relay.url ? cloudConfig.clerk.publishableKey : null;

if (publishableKey) {
  // The same native singleton ClerkProvider renders with, so the service
  // observes it for the app's lifetime without a React subscription. Clerk
  // reads the resource cache only when this creates the singleton; without
  // it, a launch load that fails offline is never retried.
  cloudAccountService.attach(
    getClerkInstance({ publishableKey, __experimental_resourceCache: resourceCache }),
  );
} else {
  // Without cloud config no account can ever activate, so drop anything a
  // previous build with cloud enabled left registered.
  deactivateCloudRelayAccount();
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      tokenCache={tokenCache}
      __experimental_resourceCache={resourceCache}
    >
      {props.children}
    </ClerkProvider>
  );
}
