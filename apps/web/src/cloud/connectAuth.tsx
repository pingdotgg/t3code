import { useAuth, useClerk } from "@clerk/react";
import {
  EnvironmentHttpBadRequestError,
  type EnvironmentConnectAuthState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

/**
 * One T3 Connect session surface across auth backends. The hosted web app
 * signs in with Clerk in the page; the desktop app signs in through its local
 * environment server, which runs the same browser OAuth flow as
 * `npx t3 connect` and shares the stored credential with it.
 */
export interface T3ConnectAuth {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  /** Account label for display (desktop; web renders Clerk's UserButton). */
  readonly identity: string | null;
  /** A desktop browser sign-in is waiting for the user to finish in the browser. */
  readonly pendingLogin: boolean;
  /** The URL the pending sign-in opened, for a manual fallback link. */
  readonly authorizationUrl: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: () => void;
  readonly signOut: () => Promise<void>;
  /**
   * Desktop only: completes a pending sign-in with a code pasted from the
   * hosted out-of-band page. Resolves with an error message to display, or
   * null when the code was accepted.
   */
  readonly submitLoginCode?: (code: string) => Promise<string | null>;
}

// Rendered when no auth provider is mounted (cloud config absent). Cloud UI
// gates itself on hasCloudPublicConfig, so this is just a safe floor.
const signedOutAuth: T3ConnectAuth = {
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  identity: null,
  pendingLogin: false,
  authorizationUrl: null,
  getToken: () => Promise.resolve(null),
  signIn: () => {},
  signOut: () => Promise.resolve(),
};

const T3ConnectAuthContext = createContext<T3ConnectAuth>(signedOutAuth);

export function useT3ConnectAuth(): T3ConnectAuth {
  return useContext(T3ConnectAuthContext);
}

/** Web: Clerk session in the page. Must be mounted under ClerkProvider. */
export function ClerkConnectAuthProvider({ children }: { readonly children: ReactNode }) {
  // A pending Clerk session must not read as signed-out, or its later
  // activation would look like a fresh sign-in.
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const clerk = useClerk();
  const value = useMemo<T3ConnectAuth>(
    () => ({
      isLoaded,
      isSignedIn: isSignedIn === true,
      userId: userId ?? null,
      identity: null,
      pendingLogin: false,
      authorizationUrl: null,
      getToken: () => getToken(resolveRelayClerkTokenOptions()),
      signIn: () => clerk.openSignIn(resolveClerkSignInProps(window.location.href)),
      signOut: () => clerk.signOut(),
    }),
    [clerk, getToken, isLoaded, isSignedIn, userId],
  );
  return <T3ConnectAuthContext.Provider value={value}>{children}</T3ConnectAuthContext.Provider>;
}

const readAuthState = Effect.gen(function* () {
  const client = yield* PrimaryEnvironmentHttpClient;
  return yield* client.connect.authState({ headers: {} });
});

const startLogin = Effect.gen(function* () {
  const client = yield* PrimaryEnvironmentHttpClient;
  return yield* client.connect.authLogin({ headers: {} });
});

const logout = Effect.gen(function* () {
  const client = yield* PrimaryEnvironmentHttpClient;
  return yield* client.connect.authLogout({ headers: {} });
});

const readAuthToken = Effect.gen(function* () {
  const client = yield* PrimaryEnvironmentHttpClient;
  return yield* client.connect.authToken({ headers: {} });
});

const submitAuthCode = (code: string) =>
  Effect.gen(function* () {
    const client = yield* PrimaryEnvironmentHttpClient;
    return yield* client.connect.authCode({ headers: {}, payload: { code } });
  });

const isBadRequest = Schema.is(EnvironmentHttpBadRequestError);

// The server reports a rejected code as a 400 with a human-readable message;
// dig it out of the wrapped client error.
function loginCodeErrorMessage(cause: unknown): string {
  for (let current = cause; typeof current === "object" && current !== null; ) {
    if (isBadRequest(current)) {
      return current.message;
    }
    current = "cause" in current ? current.cause : null;
  }
  return "Could not use that code. Start the sign-in again.";
}

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const LOGIN_WATCH_INTERVAL_MS = 2_000;

/**
 * Desktop: session state lives in the local environment server. Sign-in kicks
 * the system browser to the hosted /connect flow; the server exchanges the
 * callback and stores the credential where `t3 connect` also reads it.
 */
export function DesktopConnectAuthProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<EnvironmentConnectAuthState | null>(null);
  const tokenCacheRef = useRef<{ accessToken: string; expiresAtEpochMs: number } | null>(null);
  // Bumped on every cache invalidation so an in-flight token read started
  // before a logout or account switch cannot repopulate the cache.
  const tokenGenerationRef = useRef(0);
  const requestSeqRef = useRef(0);

  const applyState = useCallback((next: EnvironmentConnectAuthState) => {
    setState((previous) => {
      // The shared credential can be replaced with a different account by a
      // CLI re-login; a cached token from the previous account must not
      // outlive the switch.
      if (!next.authorized || (previous?.accountId ?? null) !== next.accountId) {
        tokenCacheRef.current = null;
        tokenGenerationRef.current += 1;
      }
      return next;
    });
  }, []);

  // Focus refreshes, pending-login polling, and mutations overlap; only the
  // most recently issued request may write state, so a slow stale read cannot
  // overwrite the result of a newer logout or login.
  const runStateRequest = useCallback(
    async <E,>(
      effect: Effect.Effect<EnvironmentConnectAuthState, E, PrimaryEnvironmentHttpClient>,
    ) => {
      const seq = ++requestSeqRef.current;
      const next = await runPrimaryHttp(effect);
      if (seq === requestSeqRef.current) {
        applyState(next);
      }
    },
    [applyState],
  );

  const refresh = useCallback(async () => {
    try {
      await runStateRequest(readAuthState);
    } catch (cause) {
      console.warn("[t3-connect] Could not read T3 Connect sign-in state.", cause);
    }
  }, [runStateRequest]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The bundled server may still be starting when the app mounts; retry until
  // the first state read lands.
  const isLoaded = state !== null;
  useEffect(() => {
    if (isLoaded) return;
    const interval = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(interval);
  }, [isLoaded, refresh]);

  // The credential is shared with `t3 connect`, so a CLI sign-in or logout
  // can change it while the app is open; re-read when the window regains
  // focus.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // The browser flow completes in the environment server; watch its state
  // until the pending sign-in settles either way.
  const pendingLogin = state?.pendingLogin ?? false;
  useEffect(() => {
    if (!pendingLogin) return;
    const interval = setInterval(() => void refresh(), LOGIN_WATCH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [pendingLogin, refresh]);

  const getToken = useCallback(async () => {
    const cached = tokenCacheRef.current;
    if (cached && cached.expiresAtEpochMs - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }
    const generation = tokenGenerationRef.current;
    try {
      const token = await runPrimaryHttp(readAuthToken);
      if (generation === tokenGenerationRef.current) {
        tokenCacheRef.current = token;
      }
      return token.accessToken;
    } catch (cause) {
      console.warn("[t3-connect] Could not read the T3 Connect access token.", cause);
      return null;
    }
  }, []);

  const signIn = useCallback(() => {
    void (async () => {
      try {
        await runStateRequest(startLogin);
      } catch (cause) {
        console.error("[t3-connect] Could not start T3 Connect sign-in.", cause);
      }
    })();
  }, [runStateRequest]);

  const signOut = useCallback(async () => {
    try {
      await runStateRequest(logout);
    } catch (cause) {
      console.error("[t3-connect] Could not sign out of T3 Connect.", cause);
    }
  }, [runStateRequest]);

  const submitLoginCode = useCallback(
    async (code: string) => {
      try {
        await runStateRequest(submitAuthCode(code));
        return null;
      } catch (cause) {
        return loginCodeErrorMessage(cause);
      }
    },
    [runStateRequest],
  );

  const value = useMemo<T3ConnectAuth>(
    () => ({
      isLoaded,
      // accountId can lag behind authorization for legacy `t3 connect`
      // credentials while the server backfills it; relay features need the
      // account id, so hold "signed in" until it resolves.
      isSignedIn: state?.authorized === true && state.accountId !== null,
      userId: state?.accountId ?? null,
      identity: state?.identity ?? null,
      pendingLogin,
      authorizationUrl: state?.authorizationUrl ?? null,
      getToken,
      signIn,
      signOut,
      submitLoginCode,
    }),
    [getToken, isLoaded, pendingLogin, signIn, signOut, state, submitLoginCode],
  );
  return <T3ConnectAuthContext.Provider value={value}>{children}</T3ConnectAuthContext.Provider>;
}
