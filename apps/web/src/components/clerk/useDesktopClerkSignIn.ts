import { useClerk } from "@clerk/react";
import { useSignIn, useSignUp } from "@clerk/react/legacy";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type DesktopCloudAuthOAuthStrategy,
  resolveDesktopCloudAuthOAuthOptions,
} from "../../cloud/desktopAuth";
import { toastManager } from "../ui/toast";

// Mirrors Clerk Expo's browser-based native SSO flow, with Electron handling the external browser
// and callback transport:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/expo/src/hooks/useSSO.ts
class DesktopClerkOperationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DesktopClerkOperationError";
    this.cause = cause;
  }
}

async function runDesktopClerkOperation<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new DesktopClerkOperationError(message, cause);
  }
}

function desktopClerkErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DesktopClerkOperationError) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export function useDesktopClerkSignIn() {
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
        await runDesktopClerkOperation(
          () => signIn.reload({ rotatingTokenNonce }),
          "Could not reload the desktop sign-in session.",
        );
        sessionId = sessionId || signIn.createdSessionId;

        if (!sessionId && signIn.firstFactorVerification.status === "transferable") {
          const signUpAttempt = await runDesktopClerkOperation(
            () => signUp.create({ transfer: true }),
            "Could not transfer the desktop sign-up session.",
          );
          sessionId = signUpAttempt.createdSessionId;
        }

        if (!sessionId) {
          throw new DesktopClerkOperationError("Clerk did not create a desktop session.");
        }

        await runDesktopClerkOperation(
          () => setActive({ session: sessionId! }),
          "Could not activate the desktop cloud session.",
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: desktopClerkErrorMessage(error, "Could not complete cloud sign-in."),
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

  const startOAuth = useCallback(
    async (strategy: DesktopCloudAuthOAuthStrategy) => {
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
        const redirectUrl = await runDesktopClerkOperation(
          () => window.desktopBridge?.createCloudAuthRequest() ?? Promise.resolve(undefined),
          "Desktop auth callback is unavailable.",
        );
        if (!redirectUrl) {
          throw new DesktopClerkOperationError("Desktop auth callback is unavailable.");
        }

        callbackCleanupRef.current =
          window.desktopBridge?.onCloudAuthCallback((rawUrl) => {
            clearCallbackListener();
            void completeOAuthCallback(rawUrl);
          }) ?? null;

        await runDesktopClerkOperation(
          () => signIn.create({ strategy, redirectUrl } as never),
          "Could not create the desktop OAuth request.",
        );
        const externalUrl =
          signIn.firstFactorVerification.externalVerificationRedirectURL?.toString();
        if (!externalUrl) {
          throw new DesktopClerkOperationError(
            "Clerk did not return an external OAuth redirect URL.",
          );
        }

        const opened = await runDesktopClerkOperation(
          () => window.desktopBridge?.openExternal(externalUrl) ?? Promise.resolve(false),
          "Could not open the system browser.",
        );
        if (!opened) {
          throw new DesktopClerkOperationError("Could not open the system browser.");
        }
      } catch (error) {
        clearCallbackListener();
        toastManager.add({
          type: "error",
          title: "Cloud sign-in failed",
          description: desktopClerkErrorMessage(error, "Could not start cloud sign-in."),
        });
      } finally {
        setStartingStrategy(null);
      }
    },
    [clearCallbackListener, completeOAuthCallback, signIn, signInLoaded],
  );

  return {
    isStarting: startingStrategy !== null,
    oauthOptions,
    startingStrategy,
    startOAuth,
  };
}
