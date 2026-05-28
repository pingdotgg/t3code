import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import Constants from "expo-constants";
import { type ReactNode, useEffect, useRef } from "react";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";

import { mobileRuntime } from "../../lib/runtime";
import {
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { refreshActiveLiveActivityRemoteRegistration } from "../agent-awareness/liveActivityController";

function readClerkPublishableKey(): string | null {
  const clerkConfig = Constants.expoConfig?.extra?.clerk as
    | { readonly publishableKey?: string | null }
    | undefined;
  return clerkConfig?.publishableKey ?? null;
}

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
      return;
    }

    const previous = previousTokenProviderRef.current;
    if (previous && previous.userId !== userId) {
      void mobileRuntime
        .runPromise(unregisterAgentAwarenessDeviceForCurrentUser(previous.provider))
        .catch(() => undefined);
    }
    const tokenProvider = () => getToken(RELAY_CLERK_TOKEN_OPTIONS);
    previousTokenProviderRef.current = { userId, provider: tokenProvider };
    setAgentAwarenessRelayTokenProvider(tokenProvider, userId);
    if (!previous || previous.userId !== userId) {
      void mobileRuntime
        .runPromise(refreshActiveLiveActivityRemoteRegistration())
        .catch(() => undefined);
    }
  }, [getToken, isLoaded, isSignedIn, userId]);

  useEffect(
    () => () => {
      previousTokenProviderRef.current = null;
      setAgentAwarenessRelayTokenProvider(null);
    },
    [],
  );

  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const publishableKey = readClerkPublishableKey();

  useEffect(() => {
    if (!publishableKey) {
      setAgentAwarenessRelayTokenProvider(null);
    }
  }, [publishableKey]);

  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <CloudAuthBridge>{props.children}</CloudAuthBridge>
    </ClerkProvider>
  );
}
