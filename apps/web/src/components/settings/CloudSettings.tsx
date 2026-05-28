import { SignInButton, UserButton, useAuth, useClerk } from "@clerk/react";
import { useSignIn, useSignUp } from "@clerk/react/legacy";
import { RELAY_CLERK_TOKEN_OPTIONS } from "@t3tools/shared/relayAuth";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { CloudIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DesktopCloudAuthOAuthStrategy,
  resolveDesktopCloudAuthOAuthOptions,
} from "../../cloud/desktopAuth";
import {
  collectCloudLinkTargets,
  connectManagedCloudEnvironment,
  linkEnvironmentToCloud,
  linkPrimaryEnvironmentToCloud,
  listManagedCloudEnvironments,
  readPrimaryCloudLinkState,
  readPrimaryCloudLinkTarget,
  type CloudLinkState,
  unlinkPrimaryEnvironmentFromCloud,
} from "../../cloud/linkEnvironment";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  addManagedRelayEnvironment,
  listSavedEnvironmentRecords,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { webRuntime } from "../../lib/runtime";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function hasClerkConfig(): boolean {
  return Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
}

class CloudSettingsOperationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CloudSettingsOperationError";
    this.cause = cause;
  }
}

async function runCloudOperation<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new CloudSettingsOperationError(message, cause);
  }
}

function cloudErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CloudSettingsOperationError) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function CloudSettingsPanel() {
  if (!hasClerkConfig()) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
          <SettingsRow
            title="Cloud account"
            description="Set VITE_CLERK_PUBLISHABLE_KEY to enable optional cloud features."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <CloudSettingsPanelInner />;
}

function CloudSettingsPanelInner() {
  const { getToken, isSignedIn, userId } = useAuth();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const [isLinking, setIsLinking] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [primaryLinkState, setPrimaryLinkState] = useState<CloudLinkState | null>(null);
  const [linkStateError, setLinkStateError] = useState<string | null>(null);
  const [managedEnvironments, setManagedEnvironments] = useState<
    ReadonlyArray<RelayClientEnvironmentRecord>
  >([]);
  const [isLoadingManaged, setIsLoadingManaged] = useState(false);
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<string | null>(null);
  const linkableEnvironmentCount = collectCloudLinkTargets({
    primary: primaryEnvironmentId ? readPrimaryCloudLinkTarget() : null,
    saved: listSavedEnvironmentRecords().filter((environment) => !environment.relayManaged),
  }).length;
  const linkedCloudUserId = primaryLinkState?.cloudUserId ?? null;
  const hasCloudAccountMismatch = Boolean(
    isSignedIn && userId && linkedCloudUserId && linkedCloudUserId !== userId,
  );

  const refreshPrimaryLinkState = useCallback(() => {
    if (!primaryEnvironmentId) {
      setPrimaryLinkState(null);
      setLinkStateError(null);
      return;
    }
    void webRuntime.runPromise(readPrimaryCloudLinkState()).then(
      (state) => {
        setPrimaryLinkState(state);
        setLinkStateError(null);
      },
      (error: unknown) => {
        setPrimaryLinkState(null);
        setLinkStateError(cloudErrorMessage(error, "Could not read local cloud link state."));
      },
    );
  }, [primaryEnvironmentId]);

  useEffect(() => {
    refreshPrimaryLinkState();
  }, [refreshPrimaryLinkState]);

  const refreshManagedEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      setManagedEnvironments([]);
      return;
    }
    setIsLoadingManaged(true);
    try {
      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        setManagedEnvironments([]);
        return;
      }
      setManagedEnvironments(
        await webRuntime.runPromise(listManagedCloudEnvironments({ clerkToken: token })),
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud environments unavailable",
        description: cloudErrorMessage(error, "Could not load linked environments."),
      });
    } finally {
      setIsLoadingManaged(false);
    }
  }, [getToken, isSignedIn]);

  useEffect(() => {
    void refreshManagedEnvironments();
  }, [refreshManagedEnvironments]);

  const linkEnvironments = async () => {
    if (hasCloudAccountMismatch) {
      toastManager.add({
        type: "error",
        title: "Cloud account mismatch",
        description: "This environment is linked to a different cloud account.",
      });
      return;
    }
    setIsLinking(true);
    try {
      const token = await runCloudOperation(
        () => getToken(RELAY_CLERK_TOKEN_OPTIONS),
        "Could not get the current cloud session.",
      );
      if (!token) {
        return;
      }
      const primaryTarget = readPrimaryCloudLinkTarget();
      const savedEnvironments = listSavedEnvironmentRecords().filter(
        (environment) => !environment.relayManaged,
      );
      const savedEnvironmentIds = new Set(primaryTarget ? [primaryTarget.environmentId] : []);
      if (primaryTarget) {
        await runCloudOperation(
          () => webRuntime.runPromise(linkPrimaryEnvironmentToCloud({ clerkToken: token })),
          "Could not link the local environment.",
        );
      }
      await runCloudOperation(
        () =>
          webRuntime.runPromise(
            Effect.all(
              savedEnvironments
                .filter((environment) => {
                  if (savedEnvironmentIds.has(environment.environmentId)) {
                    return false;
                  }
                  savedEnvironmentIds.add(environment.environmentId);
                  return true;
                })
                .map((environment) => linkEnvironmentToCloud({ environment, clerkToken: token })),
              { concurrency: "unbounded" },
            ),
          ),
        "Could not link environments.",
      );
      toastManager.add({
        type: "success",
        title: "Environments linked",
        description: "Relay notifications are enabled for linked environments.",
      });
      refreshPrimaryLinkState();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud link failed",
        description: cloudErrorMessage(error, "Could not link environments."),
      });
    } finally {
      setIsLinking(false);
    }
  };

  const unlinkPrimaryEnvironment = async () => {
    setIsUnlinking(true);
    try {
      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS).catch(() => null);
      await runCloudOperation(
        () => webRuntime.runPromise(unlinkPrimaryEnvironmentFromCloud({ clerkToken: token })),
        "Could not unlink the local environment.",
      );
      refreshPrimaryLinkState();
      toastManager.add({
        type: "success",
        title: "Environment unlinked",
        description: "Local relay credentials and managed endpoint runtime config were removed.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Cloud unlink failed",
        description: cloudErrorMessage(error, "Could not unlink the local environment."),
      });
    } finally {
      setIsUnlinking(false);
    }
  };

  const connectManagedEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentId(environment.environmentId);
    try {
      const token = await getToken(RELAY_CLERK_TOKEN_OPTIONS);
      if (!token) {
        throw new CloudSettingsOperationError("Could not get the current cloud session.");
      }
      const connection = await webRuntime.runPromise(
        connectManagedCloudEnvironment({ clerkToken: token, environment }),
      );
      await addManagedRelayEnvironment(connection);
      toastManager.add({
        type: "success",
        title: "Environment connected",
        description: `${connection.label} is available through its managed tunnel.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Managed connection failed",
        description: cloudErrorMessage(error, "Could not connect to the cloud environment."),
      });
    } finally {
      setConnectingEnvironmentId(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Cloud" icon={<CloudIcon className="size-3.5" />}>
        <SettingsRow
          title="Cloud account"
          description="Signing in enables relay notifications and managed tunnel connections."
          control={isSignedIn ? <UserButton /> : <CloudSignInControl />}
        />
        {isSignedIn ? (
          <SettingsRow
            title="Linked environments"
            description={
              hasCloudAccountMismatch
                ? `Linked as ${linkedCloudUserId}; signed in as ${userId}.`
                : "Grant linked environments a relay credential for APNs agent activity updates."
            }
            status={
              linkStateError ??
              (linkedCloudUserId
                ? `Linked as ${linkedCloudUserId}`
                : `${linkableEnvironmentCount} linkable environment${linkableEnvironmentCount === 1 ? "" : "s"} (${savedEnvironmentCount} saved)`)
            }
            control={
              <div className="flex items-center gap-2">
                {linkedCloudUserId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isUnlinking}
                    onClick={() => void unlinkPrimaryEnvironment()}
                  >
                    {isUnlinking ? "Unlinking..." : "Unlink"}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={
                    isLinking ||
                    isUnlinking ||
                    linkableEnvironmentCount === 0 ||
                    hasCloudAccountMismatch
                  }
                  onClick={() => void linkEnvironments()}
                >
                  {isLinking ? "Linking..." : "Link"}
                </Button>
              </div>
            }
          />
        ) : null}
        {isSignedIn ? (
          <SettingsRow
            title="Managed tunnel environments"
            description="Connect to linked environments through T3 Cloud from this frontend."
            status={
              isLoadingManaged
                ? "Loading..."
                : `${managedEnvironments.length} available environment${managedEnvironments.length === 1 ? "" : "s"}`
            }
            control={
              <Button
                size="sm"
                variant="secondary"
                disabled={isLoadingManaged}
                onClick={() => void refreshManagedEnvironments()}
              >
                Refresh
              </Button>
            }
          />
        ) : null}
        {isSignedIn
          ? managedEnvironments.map((environment) => (
              <SettingsRow
                key={environment.environmentId}
                title={environment.label}
                description={environment.endpoint.httpBaseUrl}
                control={
                  <Button
                    size="sm"
                    disabled={connectingEnvironmentId !== null}
                    onClick={() => void connectManagedEnvironment(environment)}
                  >
                    {connectingEnvironmentId === environment.environmentId
                      ? "Connecting..."
                      : "Connect"}
                  </Button>
                }
              />
            ))
          : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function CloudSignInControl() {
  if (isElectron) {
    return <DesktopCloudSignInButton />;
  }
  return <SignInButton mode="modal" />;
}

function DesktopCloudSignInButton() {
  const clerk = useClerk();
  const { setActive } = clerk;
  const { isLoaded: signInLoaded, signIn } = useSignIn();
  const { isLoaded: signUpLoaded, signUp } = useSignUp();
  const [startingStrategy, setStartingStrategy] = useState<DesktopCloudAuthOAuthStrategy | null>(
    null,
  );
  const oauthOptions = resolveDesktopCloudAuthOAuthOptions(clerk);
  const callbackCleanupRef = useRef<(() => void) | null>(null);

  const clearCallbackListener = useCallback(() => {
    callbackCleanupRef.current?.();
    callbackCleanupRef.current = null;
  }, []);

  const completeOAuthCallback = useCallback(
    async (rawUrl: string) => {
      if (!signInLoaded || !signIn || !signUpLoaded || !signUp) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: "Clerk is still loading. Try signing in again.",
        });
        return;
      }

      let rotatingTokenNonce: string | null = null;
      let sessionId: string | null = null;
      try {
        const callbackUrl = new URL(rawUrl);
        rotatingTokenNonce = callbackUrl.searchParams.get("rotating_token_nonce");
        sessionId = callbackUrl.searchParams.get("created_session_id");
      } catch {
        // Handled by the explicit nonce check below.
      }
      if (!rotatingTokenNonce) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description:
            "Clerk did not return a native session nonce. Verify this redirect URL is allowlisted for native SSO redirects.",
        });
        return;
      }

      try {
        await runCloudOperation(
          () => signIn.reload({ rotatingTokenNonce }),
          "Could not reload the desktop sign-in session.",
        );
        sessionId = sessionId || signIn.createdSessionId;

        if (!sessionId && signIn.firstFactorVerification.status === "transferable") {
          const signUpAttempt = await runCloudOperation(
            () => signUp.create({ transfer: true }),
            "Could not transfer the desktop sign-up session.",
          );
          sessionId = signUpAttempt.createdSessionId;
        }

        if (!sessionId) {
          throw new CloudSettingsOperationError("Clerk did not create a desktop session.");
        }

        await runCloudOperation(
          () => setActive({ session: sessionId! }),
          "Could not activate the desktop cloud session.",
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: cloudErrorMessage(error, "Could not complete cloud sign-in."),
        });
      }
    },
    [setActive, signIn, signInLoaded, signUp, signUpLoaded],
  );

  useEffect(() => {
    return () => {
      clearCallbackListener();
    };
  }, [clearCallbackListener]);

  const startOAuth = async (strategy: DesktopCloudAuthOAuthStrategy) => {
    if (!signInLoaded || !signIn) {
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: "Clerk is still loading. Try signing in again.",
      });
      return;
    }

    setStartingStrategy(strategy);
    clearCallbackListener();
    try {
      const redirectUrl = await runCloudOperation(
        () => window.desktopBridge?.createCloudAuthRequest() ?? Promise.resolve(undefined),
        "Desktop auth callback is unavailable.",
      );
      if (!redirectUrl) {
        throw new CloudSettingsOperationError("Desktop auth callback is unavailable.");
      }

      callbackCleanupRef.current =
        window.desktopBridge?.onCloudAuthCallback((rawUrl) => {
          clearCallbackListener();
          void completeOAuthCallback(rawUrl);
        }) ?? null;

      const signInAttempt = await runCloudOperation(
        () => signIn.create({ strategy, redirectUrl } as never),
        "Could not create the desktop OAuth request.",
      );
      const externalUrl =
        signInAttempt.firstFactorVerification.externalVerificationRedirectURL?.toString();
      if (!externalUrl) {
        throw new CloudSettingsOperationError(
          "Clerk did not return an external OAuth redirect URL.",
        );
      }

      const opened = await runCloudOperation(
        () => window.desktopBridge?.openExternal(externalUrl) ?? Promise.resolve(false),
        "Could not open the system browser.",
      );
      if (!opened) {
        throw new CloudSettingsOperationError("Could not open the system browser.");
      }
    } catch (error) {
      clearCallbackListener();
      toastManager.add({
        type: "error",
        title: "Cloud sign-in failed",
        description: cloudErrorMessage(error, "Could not start cloud sign-in."),
      });
    } finally {
      setStartingStrategy(null);
    }
  };

  const isStarting = startingStrategy !== null;

  if (oauthOptions.length === 0) {
    return (
      <Button disabled size="sm">
        No OAuth providers enabled
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {oauthOptions.map((option) => (
        <Button
          key={option.strategy}
          disabled={isStarting}
          onClick={() => void startOAuth(option.strategy)}
          size="sm"
        >
          {startingStrategy === option.strategy ? "Opening..." : `Continue with ${option.label}`}
        </Button>
      ))}
    </div>
  );
}
