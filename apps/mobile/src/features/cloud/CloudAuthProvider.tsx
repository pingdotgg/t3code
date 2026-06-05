import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { createManagedRelaySession, setManagedRelaySession } from "@t3tools/client-runtime";
import { type ReactNode, useEffect, useRef } from "react";

import { mobileRuntime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

function CloudAuthBridge(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const previousTokenProviderRef = useRef<{
    readonly userId: string;
    readonly provider: () => Promise<string | null>;
  } | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (!isSignedIn || !userId) {
      const previous = previousTokenProviderRef.current;
      previousTokenProviderRef.current = null;
      if (previous) {
        void mobileRuntime
          .runPromise(unregisterAgentAwarenessDeviceForCurrentUser(previous.provider))
          .catch(() => undefined);
      }
      setAgentAwarenessRelayTokenProvider(null);
      setManagedRelaySession(appAtomRegistry, null);
      return;
    }

    const previous = previousTokenProviderRef.current;
    if (previous && previous.userId !== userId) {
      void mobileRuntime
        .runPromise(unregisterAgentAwarenessDeviceForCurrentUser(previous.provider))
        .catch(() => undefined);
    }
    const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
    previousTokenProviderRef.current = { userId, provider: tokenProvider };
    setAgentAwarenessRelayTokenProvider(tokenProvider, userId);
    setManagedRelaySession(
      appAtomRegistry,
      createManagedRelaySession({
        accountId: userId,
        readClerkToken: tokenProvider,
      }),
    );
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(
    () => () => {
      previousTokenProviderRef.current = null;
      setAgentAwarenessRelayTokenProvider(null);
      setManagedRelaySession(appAtomRegistry, null);
    },
    [],
  );

  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const { clerkPublishableKey: publishableKey, relayUrl } = resolveCloudPublicConfig();

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      setAgentAwarenessRelayTokenProvider(null);
      setManagedRelaySession(appAtomRegistry, null);
    }
  }, [publishableKey, relayUrl]);

  if (!publishableKey || !relayUrl) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <CloudAuthBridge>{props.children}</CloudAuthBridge>
    </ClerkProvider>
  );
}
