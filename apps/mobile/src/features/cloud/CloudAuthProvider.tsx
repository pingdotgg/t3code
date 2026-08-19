import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
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
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import {
  CLERK_LOAD_TIMEOUT_MS,
  type ClerkLoadRecoveryEvent,
  initialClerkLoadRecoveryState,
  reduceClerkLoadRecovery,
} from "./clerkLoadRecovery";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
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
  const cleanupEpochRef = useRef(0);

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
      const epoch = cleanupEpochRef.current;
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        if (cleanupEpochRef.current !== epoch) {
          return;
        }
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
        if (cleanupEpochRef.current !== epoch) {
          return;
        }
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
      cleanupEpochRef.current += 1;
      previousTokenProviderRef.current = null;
      // Unmounting is not a sign-out: the user is usually still signed in, so
      // detach the awareness token provider without ending the live T3 Connect
      // session. A hung Clerk remount reuses that session; sign-out still goes
      // through deactivateCloudRelayAccount.
      releaseAgentAwarenessRelayTokenProvider();
    },
    [],
  );

  return props.children;
}

export interface CloudAuthLoadState {
  readonly remount: (reason: "auto" | "manual") => void;
  readonly timedOut: boolean;
}

const idleCloudAuthLoadState: CloudAuthLoadState = {
  remount: () => undefined,
  timedOut: false,
};

const CloudAuthLoadContext = createContext<CloudAuthLoadState>(idleCloudAuthLoadState);

export function useCloudAuthLoadState(): CloudAuthLoadState {
  return useContext(CloudAuthLoadContext);
}

function CloudAuthLoadWatchdog(props: {
  readonly onEvent: (event: ClerkLoadRecoveryEvent) => void;
  readonly onLoadedChange: (isLoaded: boolean) => void;
  readonly resumeEpoch: number;
}) {
  const { isLoaded } = useAuth({ treatPendingAsSignedOut: false });
  const isLoadedRef = useRef(isLoaded);
  isLoadedRef.current = isLoaded;

  useEffect(() => {
    props.onLoadedChange(isLoaded);
  }, [isLoaded, props.onLoadedChange]);

  useEffect(() => {
    if (isLoaded) {
      props.onEvent({ type: "loaded" });
      return;
    }
    const handle = setTimeout(() => {
      props.onEvent({
        type: "timeout",
        isActive: AppState.currentState === "active",
        isLoaded: isLoadedRef.current,
      });
    }, CLERK_LOAD_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [isLoaded, props.onEvent, props.resumeEpoch]);

  return null;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const publishableKey = config.clerk.publishableKey;
  const relayUrl = config.relay.url;
  const [recovery, setRecovery] = useState(initialClerkLoadRecoveryState);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const isLoadedRef = useRef(false);

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      deactivateCloudRelayAccount();
    }
  }, [publishableKey, relayUrl]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !isLoadedRef.current) {
        setResumeEpoch((current) => current + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  const applyRecoveryEvent = useCallback((event: ClerkLoadRecoveryEvent) => {
    setRecovery((current) => reduceClerkLoadRecovery(current, event));
  }, []);

  const remount = useCallback(
    (reason: "auto" | "manual") => {
      if (reason === "manual") {
        applyRecoveryEvent({ type: "manual-remount" });
        return;
      }
      applyRecoveryEvent({
        type: "timeout",
        isActive: true,
        isLoaded: false,
      });
    },
    [applyRecoveryEvent],
  );

  const markLoadedChange = useCallback((isLoaded: boolean) => {
    isLoadedRef.current = isLoaded;
  }, []);

  const loadState = useMemo(
    () => ({
      remount,
      timedOut: recovery.timedOut,
    }),
    [recovery.timedOut, remount],
  );

  if (!publishableKey || !relayUrl) {
    return props.children;
  }

  return (
    <CloudAuthLoadContext.Provider value={loadState}>
      <ClerkProvider
        key={recovery.generation}
        publishableKey={publishableKey}
        tokenCache={tokenCache}
      >
        <CloudAuthLoadWatchdog
          onEvent={applyRecoveryEvent}
          onLoadedChange={markLoadedChange}
          resumeEpoch={resumeEpoch}
        />
        <CloudAuthBridge>{props.children}</CloudAuthBridge>
      </ClerkProvider>
    </CloudAuthLoadContext.Provider>
  );
}
