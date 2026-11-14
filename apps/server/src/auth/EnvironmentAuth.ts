import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthAccessTokenResult,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthCreatePairingCredentialInput,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthPairingLink,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  DpopFailureReason,
  type DpopFailureReason as DpopFailureReasonType,
  mcpClientScopes,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { REUSABLE_DEV_SESSION_EXPIRES_AT, resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { requestUrl } from "../requestUrl.ts";
import { make } from "./EnvironmentAuthParts.ts";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";
export const INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

// MCP client tokens are restricted to /mcp; HTTP API and WebSocket RPC would bypass their access cap.
export const MCP_CLIENT_SUBJECT = "mcp-client";
export const MCP_CLIENT_SESSION_TTL = Duration.days(30);

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  /** Another T3 Code environment's link, whose work here stays within it. */
  readonly peerLink: boolean;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
};

class ServerAuthBootstrapCredentialValidationError extends Schema.TaggedError<ServerAuthBootstrapCredentialValidationError>()(
  "ServerAuthBootstrapCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate bootstrap credential.";
  }
}

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  "ServerAuthSessionCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate session credential.";
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  "ServerAuthAuthenticatedSessionIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated session.";
  }
}

export class ServerAuthAuthenticatedAccessTokenIssueError extends Schema.TaggedError<ServerAuthAuthenticatedAccessTokenIssueError>()(
  "ServerAuthAuthenticatedAccessTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated access token.";
  }
}

export class ServerAuthPairingLinkCreationError extends Schema.TaggedError<ServerAuthPairingLinkCreationError>()(
  "ServerAuthPairingLinkCreationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to create pairing link.";
  }
}

export class ServerAuthPairingLinksListError extends Schema.TaggedError<ServerAuthPairingLinksListError>()(
  "ServerAuthPairingLinksListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list pairing links.";
  }
}

export class ServerAuthPairingLinkRevocationError extends Schema.TaggedError<ServerAuthPairingLinkRevocationError>()(
  "ServerAuthPairingLinkRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke pairing link.";
  }
}

export class ServerAuthSessionTokenIssueError extends Schema.TaggedError<ServerAuthSessionTokenIssueError>()(
  "ServerAuthSessionTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session token.";
  }
}

export class ServerAuthSessionsListError extends Schema.TaggedError<ServerAuthSessionsListError>()(
  "ServerAuthSessionsListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list sessions.";
  }
}

export class ServerAuthSessionRevocationError extends Schema.TaggedError<ServerAuthSessionRevocationError>()(
  "ServerAuthSessionRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class ServerAuthOtherSessionsRevocationError extends Schema.TaggedError<ServerAuthOtherSessionsRevocationError>()(
  "ServerAuthOtherSessionsRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class ServerAuthDpopReplayStateRecordError extends Schema.TaggedError<ServerAuthDpopReplayStateRecordError>()(
  "ServerAuthDpopReplayStateRecordError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to record DPoP proof replay state.";
  }
}

export class ServerAuthDpopReplayKeyCalculationError extends Schema.TaggedError<ServerAuthDpopReplayKeyCalculationError>()(
  "ServerAuthDpopReplayKeyCalculationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to calculate DPoP replay key.";
  }
}

export class ServerAuthLinkedCloudAccountVerificationError extends Schema.TaggedError<ServerAuthLinkedCloudAccountVerificationError>()(
  "ServerAuthLinkedCloudAccountVerificationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Could not verify the linked cloud account.";
  }
}

export class ServerAuthLinkedCloudAccountReadError extends Schema.TaggedError<ServerAuthLinkedCloudAccountReadError>()(
  "ServerAuthLinkedCloudAccountReadError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Could not read the linked cloud account.";
  }
}

export class ServerAuthLinkedCloudAccountMissingError extends Schema.TaggedError<ServerAuthLinkedCloudAccountMissingError>()(
  "ServerAuthLinkedCloudAccountMissingError",
  {},
) {
  override get message(): string {
    return "Cloud linked user is not installed for this environment.";
  }
}

export class ServerAuthCloudLinkJwtSigningError extends Schema.TaggedError<ServerAuthCloudLinkJwtSigningError>()(
  "ServerAuthCloudLinkJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud link JWT.";
  }
}

export class ServerAuthCloudMintPublicKeyMissingError extends Schema.TaggedError<ServerAuthCloudMintPublicKeyMissingError>()(
  "ServerAuthCloudMintPublicKeyMissingError",
  {},
) {
  override get message(): string {
    return "Cloud mint public key is not installed for this environment.";
  }
}

export class ServerAuthCloudRelayIssuerMissingError extends Schema.TaggedError<ServerAuthCloudRelayIssuerMissingError>()(
  "ServerAuthCloudRelayIssuerMissingError",
  {},
) {
  override get message(): string {
    return "Cloud relay issuer is not installed for this environment.";
  }
}

export class ServerAuthCloudHealthJwtSigningError extends Schema.TaggedError<ServerAuthCloudHealthJwtSigningError>()(
  "ServerAuthCloudHealthJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud health JWT.";
  }
}

export class ServerAuthCloudMintJwtSigningError extends Schema.TaggedError<ServerAuthCloudMintJwtSigningError>()(
  "ServerAuthCloudMintJwtSigningError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to sign cloud mint JWT.";
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthBootstrapCredentialValidationError,
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthAuthenticatedAccessTokenIssueError,
  ServerAuthPairingLinkCreationError,
  ServerAuthPairingLinksListError,
  ServerAuthPairingLinkRevocationError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthLinkedCloudAccountVerificationError,
  ServerAuthLinkedCloudAccountReadError,
  ServerAuthLinkedCloudAccountMissingError,
  ServerAuthCloudLinkJwtSigningError,
  ServerAuthCloudMintPublicKeyMissingError,
  ServerAuthCloudRelayIssuerMissingError,
  ServerAuthCloudHealthJwtSigningError,
  ServerAuthCloudMintJwtSigningError,
]);
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {
    diagnostic: Schema.optional(Schema.String),
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);
export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" =>
  error._tag === "ServerAuthMissingCredentialError" ? "missing_credential" : "invalid_credential";

export const serverAuthDpopFailureReason = (
  error: ServerAuthCredentialError,
): DpopFailureReasonType | undefined =>
  error._tag === "ServerAuthInvalidCredentialError" ? error.dpopFailureReason : undefined;

class ServerAuthInvalidScopeError extends Schema.TaggedError<ServerAuthInvalidScopeError>()(
  "ServerAuthInvalidScopeError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope is invalid.";
  }
}

export class ServerAuthScopeNotGrantedError extends Schema.TaggedError<ServerAuthScopeNotGrantedError>()(
  "ServerAuthScopeNotGrantedError",
  {},
) {
  override get message(): string {
    return "The requested authentication scope was not granted.";
  }
}

export const ServerAuthInvalidRequestError = Schema.Union([
  ServerAuthInvalidScopeError,
  ServerAuthScopeNotGrantedError,
]);
export type ServerAuthInvalidRequestError = typeof ServerAuthInvalidRequestError.Type;
export const isServerAuthInvalidRequestError = Schema.is(ServerAuthInvalidRequestError);
export const serverAuthInvalidRequestReason = (
  error: ServerAuthInvalidRequestError,
): "invalid_scope" | "scope_not_granted" =>
  error._tag === "ServerAuthInvalidScopeError" ? "invalid_scope" : "scope_not_granted";

export class ServerAuthMcpApprovalCodeError extends Schema.TaggedError<ServerAuthMcpApprovalCodeError>()(
  "ServerAuthMcpApprovalCodeError",
  { reason: Schema.Literals(["unknown_or_used", "not_a_pairing_code", "insufficient_scope"]) },
) {
  override get message(): string {
    return this.reason === "insufficient_scope"
      ? "That pairing code cannot grant this access. It has not been used, so choose an access level it grants, or create a code with the standard scopes."
      : this.reason === "not_a_pairing_code"
        ? "That is not a one-time pairing code."
        : "That pairing code is unknown, expired, or already used.";
  }
}

export class ServerAuthForbiddenOperationError extends Schema.TaggedError<ServerAuthForbiddenOperationError>()(
  "ServerAuthForbiddenOperationError",
  {},
) {
  override get message(): string {
    return "The current authentication session cannot revoke itself.";
  }
}

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly createBrowserSession: (
      credential: string,
      requestMetadata: AuthClientMetadata,
      previousSessionToken?: string,
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly exchangeBootstrapCredentialForAccessToken: (
      credential: string,
      requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
      requestMetadata: AuthClientMetadata,
      input?: {
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<
      AuthAccessTokenResult,
      ServerAuthInvalidCredentialError | ServerAuthInvalidRequestError | ServerAuthInternalError
    >;
    readonly createPairingLink: (input?: {
      readonly ttl?: Duration.Duration;
      readonly label?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly subject?: string;
      readonly proofKeyThumbprint?: string;
      readonly purpose?: "startup";
    }) => Effect.Effect<
      IssuedPairingLink,
      ServerAuthInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly issuePairingCredential: (
      input?: AuthCreatePairingCredentialInput,
    ) => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly issueStartupPairingCredential: () => Effect.Effect<
      AuthPairingCredentialResult,
      ServerAuthInternalError
    >;
    readonly listPairingLinks: (input?: {
      readonly excludeSubjects?: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, ServerAuthInternalError>;
    readonly revokePairingLink: (id: string) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly issueSession: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly listClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
    readonly revokeOtherClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
      use: AuthWebSocketTicketUse,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId" | "proofKeyThumbprint">,
      input?: { readonly use?: AuthWebSocketTicketUse },
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly issueStartupPairingUrl: (
      baseUrl: string,
    ) => Effect.Effect<string, ServerAuthInternalError>;
    readonly authenticateMcpClient: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpClientSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueMcpClientSession: (input: {
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly peerLink: boolean;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      {
        readonly sessionId: AuthSessionId;
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      ServerAuthInternalError
    >;
    /** Spends a code covering all granted scopes. Rejects desktop grants and leaves refused proof-bound codes unspent. */
    readonly consumeMcpApprovalCode: (
      code: string,
      access: AuthMcpClientAccess,
    ) => Effect.Effect<void, ServerAuthMcpApprovalCodeError | ServerAuthInternalError>;
    readonly authenticateBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
  }
>()("t3/auth/EnvironmentAuth") {}

export type BootstrapExchangeResult = {
  readonly response: AuthBrowserSessionResult;
  readonly sessionToken: string;
  readonly cookieName?: string;
  readonly expireNormalCookie?: boolean;
};

const AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WebSocketUpgradeQuery = Schema.Struct({
  wsTicket: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  dpop: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});
export const decodeWebSocketUpgradeQuery = Schema.decodeEffect(WebSocketUpgradeQuery);

export const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

export function toBootstrapExchangeError(
  cause: PairingGrantStore.BootstrapCredentialError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError {
  if (PairingGrantStore.isBootstrapCredentialInternalError(cause)) {
    return new ServerAuthBootstrapCredentialValidationError({ cause });
  }

  return new ServerAuthInvalidCredentialError({
    cause,
  });
}

export const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);

export const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

export function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^Bearer /i.test(header)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function parseDpopToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(DPOP_AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
  legacyCookieName: string | undefined,
) {
  const cookieToken = request.cookies[cookieName];
  if (cookieToken) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);
  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const dpopToken = parseDpopToken(request);
  if (dpopToken !== null) {
    return { token: dpopToken, source: "dpop" } as const;
  }

  const legacyToken = legacyCookieName ? request.cookies[legacyCookieName] : undefined;
  if (legacyToken !== undefined) {
    return { token: legacyToken, source: "legacy-cookie" } as const;
  }

  return undefined;
}

type RequestCredentialSource = NonNullable<ReturnType<typeof selectRequestCredential>>["source"];

export const isBrowserCookieCredential = (source: RequestCredentialSource | "dev-cookie") =>
  source === "cookie" || source === "legacy-cookie" || source === "dev-cookie";

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : undefined;
}

// Missing Origin allows same-origin reads and non-browser clients; otherwise require
// same-origin Sec-Fetch-Site, this server's host (including X-Forwarded-Host), or a trusted app origin.
export function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  if (trustedOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  return (
    originHost === firstHeaderValue(request.headers.host) ||
    originHost === firstHeaderValue(request.headers["x-forwarded-host"])
  );
}

/** @public */
const LINK_PAIRED_SUBJECTS = { link: "one-time-token", connect: "cloud-connect" } as const;

/**
 * Revokes sessions and unused links from pairing the policy no longer allows, so a policy rolled
 * out to a machine that already had phones paired takes effect on the next start.
 */
export const revokePairedClientsThePolicyDisallows = Effect.fn(
  "EnvironmentAuth.revokePairedClientsThePolicyDisallows",
)(function* (
  policy: ManagedPolicy.ManagedPolicy["Service"],
  stores: {
    readonly sessions: SessionStore.SessionStore["Service"];
    readonly pairingLinks: PairingGrantStore.PairingGrantStore["Service"];
  },
) {
  const remoteAllowed = ManagedLimits.allowsRemoteClients(policy);
  const disallowed = new Set<string>();
  if (!remoteAllowed) disallowed.add(LINK_PAIRED_SUBJECTS.link);
  if (!ManagedLimits.allowsConnect(policy)) disallowed.add(LINK_PAIRED_SUBJECTS.connect);
  if (disallowed.size === 0) return;
  const sessions = (yield* stores.sessions.listActive()).filter(
    (session) =>
      disallowed.has(session.subject) ||
      // The startup link also pairs browsers on this machine; only a device elsewhere goes.
      (!remoteAllowed &&
        session.subject === INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT &&
        session.client.ipAddress !== undefined &&
        !isLocalLoopbackHost(session.client.ipAddress)),
  );
  const links = (yield* stores.pairingLinks.listActive()).filter((link) =>
    disallowed.has(link.subject),
  );
  yield* Effect.forEach(sessions, (session) => stores.sessions.revoke(session.sessionId), {
    discard: true,
  });
  yield* Effect.forEach(links, (link) => stores.pairingLinks.revoke(link.id), { discard: true });
  if (sessions.length > 0 || links.length > 0) {
    yield* Effect.logInfo("Revoked clients the managed policy does not allow.", {
      sessions: sessions.length,
      pairingLinks: links.length,
    });
  }
});

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provideMerge(PairingGrantStore.layer),
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

const layerStorage = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig);

export const layerRuntime = layer.pipe(
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
export * from "./EnvironmentAuthParts.ts";
