import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";
import { removeCloudEnvironments } from "./cloud-drafts";

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

type CloudRelayAccountProvider = {
  readonly userId: string;
  readonly provider: () => Promise<string | null>;
};

function CloudAuthBridge(props: {
  readonly children: ReactNode;
  readonly previousTokenProviderRef: { current: CloudRelayAccountProvider | null };
  readonly observedAccountRef: { current: string | null | undefined };
  readonly accountTransitionRef: { current: Promise<void> | null };
  readonly cleanupEpochRef: { current: number };
}) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const removeRelayEnvironments = useAtomCommand(removeCloudEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const previousTokenProviderRef = props.previousTokenProviderRef;
  const observedAccountRef = props.observedAccountRef;
  const accountTransitionRef = props.accountTransitionRef;
  const cleanupEpochRef = props.cleanupEpochRef;

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

    const cleanUpAccount = async (
      previous: {
        readonly userId: string;
        readonly provider: () => Promise<string | null>;
      } | null,
      accountId: string | null,
    ) => {
      const removal = await removeRelayEnvironments(accountId);
      if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
      const cleanup = [
        resetManagedRelayTokenCache(),
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
    };
    const queueAccountCleanup = (previous: typeof previousTokenProviderRef.current) => {
      const epoch = cleanupEpochRef.current;
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition
        .catch(() => {})
        .then(() => {
          if (cleanupEpochRef.current !== epoch) {
            return;
          }
          return cleanUpAccount(previous, previousObservedAccount ?? null);
        });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      const previous = previousTokenProviderRef.current;
      previousTokenProviderRef.current = null;
      deactivateCloudRelayAccount();
      if (previousObservedAccount !== null) {
        void settlePromise(() => queueAccountCleanup(previous)).then((result) => {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        });
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
      const activation = (async () => {
        await transition;
        if (cancelled) return;
        const storedAccount = await getComposerCloudAccountId();
        if (storedAccount !== null && storedAccount !== userId) {
          await cleanUpAccount(null, storedAccount);
        }
        if (cancelled) return;
        await restoreCloudComposerDrafts(userId);
        activateSession();
      })();
      accountTransitionRef.current = activation;
      void settlePromise(() => activation).then((result) => {
        reportAtomCommandResult(result, { label: "cloud account activation" });
      });
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
      // A failed disk write can be retried. The persisted account check above
      // still requires cleanup before activating a different account.
      activateAfterTransition((accountTransitionRef.current ?? Promise.resolve()).catch(() => {}));
    }

    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(
    () => () => {
      // Unmounting is not a sign-out. Keep the account-transition refs on the
      // parent so a Clerk remount does not discard in-flight cleanup or look like
      // a cold start. Sign-out still goes through deactivateCloudRelayAccount.
      releaseAgentAwarenessRelayTokenProvider();
    },
    [],
  );

  return props.children;
}

export interface CloudAuthLoadState {
  readonly remount: () => void;
}

const idleCloudAuthLoadState: CloudAuthLoadState = {
  remount: () => undefined,
};

const CloudAuthLoadContext = createContext<CloudAuthLoadState>(idleCloudAuthLoadState);

export function useCloudAuthLoadState(): CloudAuthLoadState {
  return useContext(CloudAuthLoadContext);
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const publishableKey = config.clerk.publishableKey;
  const relayUrl = config.relay.url;
  const [generation, setGeneration] = useState(0);
  const previousTokenProviderRef = useRef<CloudRelayAccountProvider | null>(null);
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);
  const cleanupEpochRef = useRef(0);

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      deactivateCloudRelayAccount();
    }
  }, [publishableKey, relayUrl]);

  useEffect(
    () => () => {
      cleanupEpochRef.current += 1;
    },
    [],
  );

  const remount = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  const loadState = useMemo(
    () => ({
      remount,
    }),
    [remount],
  );

  if (!publishableKey || !relayUrl) {
    return props.children;
  }

  return (
    <CloudAuthLoadContext.Provider value={loadState}>
      <ClerkProvider key={generation} publishableKey={publishableKey} tokenCache={tokenCache}>
        <CloudAuthBridge
          previousTokenProviderRef={previousTokenProviderRef}
          observedAccountRef={observedAccountRef}
          accountTransitionRef={accountTransitionRef}
          cleanupEpochRef={cleanupEpochRef}
        >
          {props.children}
        </CloudAuthBridge>
      </ClerkProvider>
    </CloudAuthLoadContext.Provider>
  );
}
