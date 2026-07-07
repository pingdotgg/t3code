import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useRef } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function CloudAuthBridge(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const previousTokenProviderRef = useRef<{
    readonly userId: string;
    readonly provider: () => Promise<string | null>;
  } | null>(null);
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded) {
      return;
    }

    const previousObservedAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = (
      previous: {
        readonly userId: string;
        readonly provider: () => Promise<string | null>;
      } | null,
    ) => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const cleanup = [
          resetManagedRelayTokenCache(),
          removeRelayEnvironments(),
          ...(previous
            ? [
                settleAsyncResult(() =>
                  runtime.runPromiseExit(
                    unregisterAgentAwarenessDeviceForCurrentUser(previous.provider),
                  ),
                ),
              ]
            : []),
        ];
        const results = await Promise.all(cleanup);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      const previous = previousTokenProviderRef.current;
      previousTokenProviderRef.current = null;
      deactivateCloudRelayAccount();
      if (previousObservedAccount !== null) {
        void queueAccountCleanup(previous);
      }
      return;
    }

    const previous = previousTokenProviderRef.current;
    const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
    const activateSession = () => {
      if (cancelled) {
        return;
      }
      previousTokenProviderRef.current = { userId, provider: tokenProvider };
      activateCloudRelayAccount(userId, tokenProvider);
    };
    const activateAfterTransition = (transition: Promise<void>) => {
      void (async () => {
        const result = await settlePromise(async () => {
          await transition;
          activateSession();
        });
        reportAtomCommandResult(result, { label: "cloud account activation" });
      })();
    };
    if (
      previousObservedAccount !== undefined &&
      previousObservedAccount !== null &&
      previousObservedAccount !== userId
    ) {
      previousTokenProviderRef.current = null;
      deactivateCloudRelayAccount();
      activateAfterTransition(queueAccountCleanup(previous));
    } else {
      activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
    }

    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(
    () => () => {
      previousTokenProviderRef.current = null;
      // Unmounting is not a sign-out: the user is usually still signed in, so
      // detach the provider without ending lock-screen activities or wiping the
      // persisted registration (a remount reuses both).
      releaseAgentAwarenessRelayTokenProvider();
      setManagedRelaySession(appAtomRegistry, null);
    },
    [],
  );

  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const publishableKey = config.clerk.publishableKey;
  const relayUrl = config.relay.url;

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      deactivateCloudRelayAccount();
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
