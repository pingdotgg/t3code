import { getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import * as Data from "effect/Data";
import { useCallback, useRef } from "react";
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

interface NativeClerkModule extends TurboModule {
  readonly getClientToken?: () => Promise<string | null>;
  readonly presentAuth?: (options: {
    readonly dismissable: boolean;
    readonly mode: "signInOrUp";
  }) => Promise<NativeAuthResult | null>;
}

interface NativeAuthResult {
  readonly cancelled?: boolean;
  readonly session?: {
    readonly id?: string;
  };
  readonly sessionId?: string;
}

interface ClerkWithNativeSync {
  readonly __internal_reloadInitialResources?: () => Promise<void>;
  readonly setActive?: (params: { readonly session: string }) => Promise<void>;
}

const NativeClerk = TurboModuleRegistry.get<NativeClerkModule>("ClerkExpo");

class NativeClerkAuthError extends Data.TaggedError("NativeClerkAuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

async function syncNativeSession(sessionId: string): Promise<void> {
  const getClientToken = NativeClerk?.getClientToken;
  let nativeClientToken: string | null = null;
  if (getClientToken) {
    try {
      nativeClientToken = await getClientToken();
    } catch (cause) {
      throw new NativeClerkAuthError({
        message: "Could not read native Clerk client token.",
        cause,
      });
    }
  }
  if (nativeClientToken) {
    const saveToken = tokenCache?.saveToken;
    if (saveToken) {
      try {
        await saveToken(CLERK_CLIENT_JWT_KEY, nativeClientToken);
      } catch (cause) {
        throw new NativeClerkAuthError({
          message: "Could not save native Clerk client token.",
          cause,
        });
      }
    }
  }

  const clerk = getClerkInstance();
  const clerkWithNativeSync = clerk as ClerkWithNativeSync;
  const reloadInitialResources = clerkWithNativeSync.__internal_reloadInitialResources;
  if (reloadInitialResources) {
    try {
      await reloadInitialResources();
    } catch (cause) {
      throw new NativeClerkAuthError({
        message: "Could not reload Clerk resources after native auth.",
        cause,
      });
    }
  }
  const setActive = clerkWithNativeSync.setActive;
  if (setActive) {
    try {
      await setActive({ session: sessionId });
    } catch (cause) {
      throw new NativeClerkAuthError({
        message: "Could not activate native Clerk session.",
        cause,
      });
    }
  }
}

export function useNativeClerkAuthModal() {
  const presentingRef = useRef(false);

  const presentAuth = useCallback(async (): Promise<void> => {
    if (presentingRef.current || !NativeClerk?.presentAuth) {
      return;
    }

    presentingRef.current = true;
    const presentNativeAuth = NativeClerk.presentAuth;
    try {
      // Clerk's iOS AuthView is not inline. It presents this same native modal
      // internally; call the presenter directly so Expo Router does not render
      // an empty formSheet behind it.
      let result: NativeAuthResult | null;
      try {
        result = await presentNativeAuth({
          dismissable: true,
          mode: "signInOrUp",
        });
      } catch (cause) {
        throw new NativeClerkAuthError({
          message: "Native Clerk auth presentation failed.",
          cause,
        });
      }
      const sessionId = result?.sessionId ?? result?.session?.id ?? null;
      if (sessionId && !result?.cancelled) {
        await syncNativeSession(sessionId);
      }
    } catch (error) {
      if (__DEV__) {
        console.error("[useNativeClerkAuthModal] presentAuth failed:", error);
      }
    } finally {
      presentingRef.current = false;
    }
  }, []);

  return {
    isAvailable: !!NativeClerk?.presentAuth,
    presentAuth,
  };
}
