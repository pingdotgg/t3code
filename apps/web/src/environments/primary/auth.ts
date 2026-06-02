import type {
  AuthBrowserSessionResult,
  AuthClientMetadata,
  AuthEnvironmentScope,
  AuthPairingCredentialResult,
  AuthSessionId,
  AuthSessionState,
} from "@t3tools/contracts";
import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import type { EnvironmentHttpCommonError as EnvironmentHttpCommonErrorType } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/unstable/http";

import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

import { PrimaryEnvironmentHttpClient } from "./httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

export class BootstrapHttpError extends Data.TaggedError("BootstrapHttpError")<{
  readonly message: string;
  readonly status: number;
}> {}
const isBootstrapHttpError = (u: unknown): u is BootstrapHttpError =>
  Predicate.isTagged(u, "BootstrapHttpError");
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly method: "browser-session-cookie" | "bearer-access-token";
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() === url.toString()) {
    return;
  }
  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

function getDesktopBootstrapCredential(): string | null {
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

export async function fetchSessionState(): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.auth.session({ headers: {} })),
        ),
      );
    } catch (error) {
      const status = readHttpApiStatus(error);
      throw new BootstrapHttpError({
        message: `Failed to load server auth session state (${status ?? "unknown"}).`,
        status: status ?? 500,
      });
    }
  });
}

function readHttpApiStatus(error: unknown): number | null {
  if (isEnvironmentHttpCommonError(error)) {
    return readEnvironmentHttpErrorStatus(error);
  }
  return HttpClientError.isHttpClientError(error) && error.response !== undefined
    ? error.response.status
    : null;
}

function readEnvironmentHttpErrorStatus(error: EnvironmentHttpCommonErrorType): number {
  switch (error._tag) {
    case "EnvironmentRequestInvalidError":
      return 400;
    case "EnvironmentAuthInvalidError":
      return 401;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return 403;
    case "EnvironmentInternalError":
      return 500;
  }
}

function readHttpApiErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!isEnvironmentHttpCommonError(error)) {
    return fallbackMessage;
  }
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return error.reason === "missing_credential"
        ? "Authentication required."
        : "Invalid bootstrap credential.";
    case "EnvironmentRequestInvalidError":
      return error.reason === "invalid_scope"
        ? "Requested token scope is invalid."
        : "Requested scope exceeds the bootstrap credential grant.";
    case "EnvironmentScopeRequiredError":
      return `The authenticated token is missing required scope: ${error.requiredScope}.`;
    case "EnvironmentOperationForbiddenError":
      return "This operation is not allowed for the current session.";
    case "EnvironmentInternalError":
      return fallbackMessage;
  }
}

const INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES = new Set([
  "Invalid bootstrap credential.",
  "Unknown bootstrap credential.",
]);

function toFriendlyBootstrapErrorMessage(status: number, message: string): string {
  const trimmedMessage = message.trim();
  if (status === 401 && INVALID_BOOTSTRAP_CREDENTIAL_MESSAGES.has(trimmedMessage)) {
    return "Invalid pairing token. Check the token and try again.";
  }

  return trimmedMessage;
}

async function exchangeBootstrapCredential(credential: string): Promise<AuthBrowserSessionResult> {
  return retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.auth.browserSession({ payload: { credential } })),
        ),
      );
    } catch (error) {
      const status = readHttpApiStatus(error) ?? 500;
      const message = toFriendlyBootstrapErrorMessage(status, readHttpApiErrorMessage(error, ""));
      throw new BootstrapHttpError({
        message: message || `Failed to bootstrap auth session (${status}).`,
        status,
      });
    }
  });
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();
    if (session.authenticated) {
      return session;
    }

    if (Date.now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new Error("Timed out waiting for authenticated session after bootstrap.");
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isBootstrapHttpError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const bootstrapCredential = getDesktopBootstrapCredential();
  const currentSession = await fetchSessionState();
  if (currentSession.authenticated) {
    return { status: "authenticated" };
  }

  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    await waitForAuthenticatedSessionAfterBootstrap();
    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new Error("Enter a pairing token to continue.");
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

export async function createServerPairingCredential(input?: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
}): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = input?.label?.trim();
  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.pairingCredential({
            headers: {},
            payload: {
              ...(trimmedLabel ? { label: trimmedLabel } : {}),
              ...(input?.scopes ? { scopes: input.scopes } : {}),
            },
          }),
        ),
      ),
    );
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to create pairing credential (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  try {
    const pairingLinks = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.pairingLinks({ headers: {} })),
      ),
    );
    return pairingLinks.map((pairingLink) => {
      const timestamps = {
        createdAt: DateTime.formatIso(pairingLink.createdAt),
        expiresAt: DateTime.formatIso(pairingLink.expiresAt),
      };
      if (pairingLink.label === undefined) {
        return {
          id: pairingLink.id,
          credential: pairingLink.credential,
          scopes: pairingLink.scopes,
          subject: pairingLink.subject,
          createdAt: timestamps.createdAt,
          expiresAt: timestamps.expiresAt,
        };
      }
      return {
        id: pairingLink.id,
        credential: pairingLink.credential,
        scopes: pairingLink.scopes,
        subject: pairingLink.subject,
        label: pairingLink.label,
        createdAt: timestamps.createdAt,
        expiresAt: timestamps.expiresAt,
      };
    });
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to load pairing links (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokePairingLink({ headers: {}, payload: { id } })),
      ),
    );
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to revoke pairing link (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  try {
    const clientSessions = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.clients({ headers: {} })),
      ),
    );
    return clientSessions.map((clientSession) => ({
      sessionId: clientSession.sessionId,
      subject: clientSession.subject,
      scopes: clientSession.scopes,
      method: clientSession.method,
      client: clientSession.client,
      issuedAt: DateTime.formatIso(clientSession.issuedAt),
      expiresAt: DateTime.formatIso(clientSession.expiresAt),
      lastConnectedAt:
        clientSession.lastConnectedAt === null
          ? null
          : DateTime.formatIso(clientSession.lastConnectedAt),
      connected: clientSession.connected,
      current: clientSession.current,
    }));
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to load paired clients (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.revokeClient({ headers: {}, payload: { sessionId } }),
        ),
      ),
    );
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to revoke client session (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  try {
    const result = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokeOtherClients({ headers: {} })),
      ),
    );
    return result.revokedCount;
  } catch (error) {
    throw new Error(
      readHttpApiErrorMessage(
        error,
        `Failed to revoke other client sessions (${readHttpApiStatus(error) ?? "unknown"}).`,
      ),
      { cause: error },
    );
  }
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (resolvedAuthenticatedGateState?.status === "authenticated") {
    return resolvedAuthenticatedGateState;
  }

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;
  return nextPromise
    .then((result) => {
      if (result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}
