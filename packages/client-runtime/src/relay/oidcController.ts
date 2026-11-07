import type { CloudAccountSource } from "./cloudAccountService.ts";
import {
  OidcError,
  buildAuthorizeUrl,
  createPkcePair,
  discoverOidc,
  exchangeAuthorizationCode,
  isIdTokenFresh,
  isPermanentRefreshFailure,
  oidcAccountLabel,
  randomToken,
  refreshOidcTokens,
  type OidcMetadata,
  type OidcTokens,
} from "@t3tools/shared/oidc";

/** The slice of `Storage` the controller needs. */
export interface KeyValueStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

interface StoredSession {
  readonly idToken: string;
  readonly refreshToken: string | null;
  readonly expiresAtEpochMs: number;
  readonly userId: string;
  readonly label: string;
}

interface PendingAuthorization {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: string;
}

export interface OidcSnapshot {
  readonly userId: string | null;
  readonly label: string | null;
}

export interface OidcControllerDeps {
  readonly config: { readonly issuer: string; readonly clientId: string };
  readonly redirectUri: string;
  /** Survives reloads and is shared between tabs. */
  readonly sessions: KeyValueStore;
  /** Holds the sign-in in flight for this tab only. */
  readonly pending: KeyValueStore;
  readonly navigate: (url: string) => void;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** Serializes refreshes across tabs: providers that rotate refresh tokens reject a stale one. */
  readonly withRefreshLock?: <A>(run: () => Promise<A>) => Promise<A>;
}

const SIGNED_OUT: OidcSnapshot = { userId: null, label: null };
const PENDING_KEY = "t3-oidc-pending";

const parseJson = <A>(value: string | null): A | null => {
  if (value === null) return null;
  try {
    return JSON.parse(value) as A;
  } catch {
    return null;
  }
};

// The return path comes from this tab's own storage, but still must never leave the origin.
const safeReturnTo = (value: string): string =>
  value.startsWith("/") && !value.startsWith("//") ? value : "/";

export function createOidcController(deps: OidcControllerDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const withRefreshLock = deps.withRefreshLock ?? (<A>(run: () => Promise<A>) => run());
  const storageKey = `t3-oidc-session:${deps.config.issuer}:${deps.config.clientId}`;

  const readSession = (): StoredSession | null =>
    parseJson<StoredSession>(deps.sessions.getItem(storageKey));
  let session = readSession();
  const toSnapshot = (value: StoredSession | null): OidcSnapshot =>
    value === null ? SIGNED_OUT : { userId: value.userId, label: value.label };
  let snapshot = toSnapshot(session);
  const listeners = new Set<() => void>();

  const publish = (next: StoredSession | null) => {
    session = next;
    if (next === null) {
      deps.sessions.removeItem(storageKey);
    } else {
      deps.sessions.setItem(storageKey, JSON.stringify(next));
    }
    const nextSnapshot = toSnapshot(next);
    if (nextSnapshot.userId !== snapshot.userId || nextSnapshot.label !== snapshot.label) {
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    }
  };

  const toStored = (tokens: OidcTokens): StoredSession => ({
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    expiresAtEpochMs: tokens.expiresAtEpochMs,
    userId: tokens.claims.sub,
    label: oidcAccountLabel(tokens.claims),
  });

  let metadataPromise: Promise<OidcMetadata> | null = null;
  const metadata = () => {
    metadataPromise ??= discoverOidc(deps.config.issuer, fetchImpl).catch((error: unknown) => {
      metadataPromise = null;
      throw error;
    });
    return metadataPromise;
  };

  const startAuthorization = async (returnTo: string): Promise<string> => {
    const [oidc, pkce] = await Promise.all([metadata(), createPkcePair()]);
    const request: PendingAuthorization = {
      state: randomToken(16),
      nonce: randomToken(16),
      verifier: pkce.verifier,
      returnTo: safeReturnTo(returnTo),
    };
    deps.pending.setItem(PENDING_KEY, JSON.stringify(request));
    return buildAuthorizeUrl({
      authorizationEndpoint: oidc.authorizationEndpoint,
      clientId: deps.config.clientId,
      redirectUri: deps.redirectUri,
      state: request.state,
      nonce: request.nonce,
      challenge: pkce.challenge,
    });
  };

  /** Leaves the page for the provider; the redirect back is finished by `completeSignIn`. */
  const signIn = async (returnTo = "/"): Promise<void> => {
    deps.navigate(await startAuthorization(returnTo));
  };

  /** Finishes the redirect back from the provider and returns where to send the user next. */
  const completeSignIn = async (callbackUrl: string): Promise<string> => {
    const request = parseJson<PendingAuthorization>(deps.pending.getItem(PENDING_KEY));
    // One attempt per redirect: a replayed callback must not find the request again.
    deps.pending.removeItem(PENDING_KEY);
    const params = new URL(callbackUrl).searchParams;
    const providerError = params.get("error");
    if (providerError !== null) {
      throw new OidcError({
        code: "token_request_failed",
        message: `The provider refused the sign-in (${providerError}).`,
        oauthError: providerError,
      });
    }
    const code = params.get("code");
    if (request === null || code === null || params.get("state") !== request.state) {
      throw new OidcError({
        code: "token_request_failed",
        message: "The sign-in response does not match a request from this tab.",
      });
    }
    const tokens = await exchangeAuthorizationCode({
      metadata: await metadata(),
      clientId: deps.config.clientId,
      redirectUri: deps.redirectUri,
      code,
      verifier: request.verifier,
      nonce: request.nonce,
      fetch: fetchImpl,
    });
    publish(toStored(tokens));
    return safeReturnTo(request.returnTo);
  };

  /**
   * For apps that show the provider in an in-app browser: `prompt` opens the URL and resolves with
   * the URL the provider redirected back to.
   */
  const signInWithPrompt = async (prompt: (authorizeUrl: string) => Promise<string>) =>
    completeSignIn(await prompt(await startAuthorization("/")));

  let refreshing: Promise<string | null> | null = null;
  const refresh = (): Promise<string | null> => {
    refreshing ??= withRefreshLock(async () => {
      // Another tab may have refreshed while this one waited for the lock.
      const current = readSession();
      if (current !== null && isIdTokenFresh(current, now())) {
        publish(current);
        return current.idToken;
      }
      if (current === null || current.refreshToken === null) {
        publish(null);
        return null;
      }
      try {
        const tokens = await refreshOidcTokens({
          metadata: await metadata(),
          clientId: deps.config.clientId,
          refreshToken: current.refreshToken,
          fetch: fetchImpl,
        });
        publish(toStored(tokens));
        return tokens.idToken;
      } catch (error) {
        if (isPermanentRefreshFailure(error)) {
          publish(null);
          return null;
        }
        throw error;
      }
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  /** The ID token the relay verifies. Null when signed out; throws when the provider is unreachable. */
  const getToken = async (): Promise<string | null> => {
    if (session === null) return null;
    return isIdTokenFresh(session, now()) ? session.idToken : refresh();
  };

  const signOut = async (): Promise<void> => {
    deps.pending.removeItem(PENDING_KEY);
    publish(null);
  };

  /** Adopts a session another tab wrote or removed. */
  const syncFromStorage = () => publish(readSession());

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const addListener: CloudAccountSource["addListener"] = (listener) => {
    const emit = () =>
      listener({ user: snapshot.userId === null ? null : { id: snapshot.userId } });
    emit();
    return subscribe(emit);
  };

  return {
    storageKey,
    getSnapshot: () => snapshot,
    subscribe,
    addListener,
    signIn,
    signInWithPrompt,
    completeSignIn,
    getToken,
    signOut,
    syncFromStorage,
  };
}

export type OidcController = ReturnType<typeof createOidcController>;
