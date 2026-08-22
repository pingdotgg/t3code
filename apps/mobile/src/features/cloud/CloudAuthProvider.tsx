import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useRef } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { runtime } from "../../lib/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import {
  invalidateBackgroundManagedRelayAuth,
  refreshBackgroundManagedRelayAuth,
} from "./backgroundManagedRelayAuth";
import { managedRelaySessionOwnership } from "./managedRelaySessionOwnership";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

export function deactivateCloudRelayAccount(
  options: { readonly refreshBackground?: boolean } = {},
): void {
  setAgentAwarenessRelayTokenProvider(null);
  invalidateBackgroundManagedRelayAuth();
  managedRelaySessionOwnership.clear();
  if (options.refreshBackground !== false) {
    void refreshBackgroundManagedRelayAuth();
  }
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  managedRelaySessionOwnership.setOwner("ui", {
    accountId,
    readClerkToken: tokenProvider,
  });
  void refreshBackgroundManagedRelayAuth();
}

export function releaseCloudRelayUiAccount(
  options: { readonly refreshAfter?: Promise<void> | null } = {},
): void {
  releaseAgentAwarenessRelayTokenProvider();
  managedRelaySessionOwnership.releaseOwner("ui");
  const refreshBackground = () => {
    void refreshBackgroundManagedRelayAuth();
  };
  const refreshAfter = options.refreshAfter ?? null;
  if (refreshAfter === null) {
    refreshBackground();
    return;
  }
  void refreshAfter.then(refreshBackground, refreshBackground);
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

    // Every sign-in or account switch that completes during this session (a
    // cold start observes undefined → account and must not re-prompt) requests
    // the T3 Connect onboarding sheet — account transitions clear the
    // connected environments, so each new session starts with no devices to
    // reach. The request itself is issued after the cleanup transition inside
    // activateSession, so the sheet never lists the previous account's
    // environments; sign-out drops any not-yet-presented request instead.
    const isAccountTransition =
      previousObservedAccount !== undefined && previousObservedAccount !== nextAccount;
    if (isAccountTransition && nextAccount === null) {
      clearConnectOnboardingRequest();
    }

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
      if (isAccountTransition) {
        requestConnectOnboarding(userId);
      }
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
      // Clerk already exposes the new account here. Keep background auth
      // invalidated until the previous account's cleanup has completed;
      // activateCloudRelayAccount refreshes it after the transition settles.
      deactivateCloudRelayAccount({ refreshBackground: false });
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
      releaseCloudRelayUiAccount({ refreshAfter: accountTransitionRef.current });
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
