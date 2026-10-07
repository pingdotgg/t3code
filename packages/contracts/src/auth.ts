import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import {
  AuthSessionId,
  ClientSurface,
  ClientWebDeployment,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Declares the server's overall authentication posture.
 *
 * This is a high-level policy label that tells clients how the environment is
 * expected to be accessed, not a transport detail and not an exhaustive list
 * of every accepted credential.
 *
 * Typical usage:
 * - rendered in auth/pairing UI so the user understands what kind of
 *   environment they are connecting to
 * - used by clients to decide whether silent desktop bootstrap is expected or
 *   whether an explicit pairing flow should be shown
 *
 * Meanings:
 * - `desktop-managed-local`: local desktop-managed environment with narrow
 *   trusted bootstrap, intended to avoid login prompts on the same machine
 * - `loopback-browser`: standalone local server intended for browser pairing on
 *   the same machine
 * - `remote-reachable`: environment intended to be reached from other devices
 *   or networks, where explicit pairing/auth is expected
 * - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
 *   unsafe escape hatch, not a normal deployment mode
 */
export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

/**
 * A credential type that can be exchanged for a real authenticated session.
 *
 * Bootstrap methods are for establishing trust at the start of a connection or
 * pairing flow. They are not the long-lived credential used for ordinary
 * authenticated HTTP / WebSocket traffic after pairing succeeds.
 *
 * Current methods:
 * - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
 *   shell can pair the renderer without a login screen
 * - `one-time-token`: a short-lived pairing token, suitable for manual pairing
 *   flows such as `/pair?token=...`
 */
export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

/**
 * A credential type accepted for steady-state authenticated requests after a
 * client has already paired.
 *
 * These methods are used by the server-wide auth layer for privileged HTTP and
 * WebSocket access. They are distinct from bootstrap methods so clients can
 * reason clearly about "pair first, then use session auth".
 *
 * Current methods:
 * - `browser-session-cookie`: cookie-backed browser session, used by the web
 *   app after bootstrap/pairing
 * - `bearer-access-token`: scoped token suitable for non-cookie or
 *   non-browser clients
 * - `dpop-access-token`: scoped proof-of-possession token used by managed
 *   relay connections
 */
export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-access-token",
  "dpop-access-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthSettingsWriteScope = "settings:write" as const;
export const AuthProvidersManageScope = "providers:manage" as const;
export const AuthEnvironmentMaintainScope = "environment:maintain" as const;
export const AuthTerminalOperateScope = "terminal:operate" as const;
export const AuthSourceControlWriteScope = "source-control:write" as const;
export const AuthFilesystemReadScope = "filesystem:read" as const;
export const AuthFilesystemWriteScope = "filesystem:write" as const;
/** Retained for decoding existing credentials; grants no current RPC access. */
const AuthReviewWriteScope = "review:write" as const;
export const AuthAccessReadScope = "access:read" as const;
export const AuthAccessWriteScope = "access:write" as const;
export const AuthRelayReadScope = "relay:read" as const;
export const AuthRelayWriteScope = "relay:write" as const;
export const AuthEnvironmentScope = Schema.Literals([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthReviewWriteScope,
  AuthSourceControlWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
]);
export type AuthEnvironmentScope = typeof AuthEnvironmentScope.Type;
export const AuthEnvironmentScopes = Schema.Array(AuthEnvironmentScope);
export type AuthEnvironmentScopes = typeof AuthEnvironmentScopes.Type;

export const AuthGrantScope = Schema.Literals(
  AuthEnvironmentScope.literals.filter((scope) => scope !== AuthReviewWriteScope),
);
export type AuthGrantScope = typeof AuthGrantScope.Type;
export const AuthGrantScopes = Schema.Array(AuthGrantScope);
export type AuthGrantScopes = typeof AuthGrantScopes.Type;

export const AuthStandardClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthRelayReadScope,
] as const;
export const AuthAdministrativeScopes = [
  ...AuthStandardClientScopes,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
] as const;

export const AuthTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const AuthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const AuthEnvironmentBootstrapTokenType =
  "urn:t3:params:oauth:token-type:environment-bootstrap" as const;

/**
 * Server-advertised auth capabilities for a specific execution environment.
 *
 * Clients should treat this as the authoritative description of how that
 * environment expects to be paired and how authenticated requests should be
 * made afterward.
 *
 * Field meanings:
 * - `policy`: high-level auth posture for the environment
 * - `bootstrapMethods`: pairing/bootstrap methods the server is currently
 *   willing to accept
 * - `sessionMethods`: authenticated request/session methods the server supports
 *   once pairing is complete
 * - `sessionCookieName`: cookie name clients should expect when
 *   `browser-session-cookie` is in use
 *
 * This descriptor is intentionally capability-oriented. It lets clients choose
 * the right UX without embedding server-specific auth logic or assuming a
 * single access method.
 */
export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
  /** Older servers omit this and authorize self-updates with orchestration:operate. */
  serverUpdateScope: Schema.optionalKey(Schema.Literal(AuthEnvironmentMaintainScope)),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthBrowserSessionRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBrowserSessionRequest = typeof AuthBrowserSessionRequest.Type;

export const AuthBrowserSessionResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  scopes: AuthEnvironmentScopes,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBrowserSessionResult = typeof AuthBrowserSessionResult.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  osMajorVersion: Schema.optionalKey(Schema.Int),
  deviceModel: Schema.optionalKey(TrimmedNonEmptyString),
  surface: Schema.optionalKey(ClientSurface),
  webDeployment: Schema.optionalKey(ClientWebDeployment),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;

export const AuthTokenExchangeRequest = Schema.Struct({
  grant_type: Schema.Literal(AuthTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString,
  subject_token_type: Schema.Literal(AuthEnvironmentBootstrapTokenType),
  requested_token_type: Schema.Literal(AuthAccessTokenType),
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  client_label: Schema.optionalKey(TrimmedNonEmptyString),
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = typeof AuthTokenExchangeRequest.Type;

export const AuthAccessTokenResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literals(["Bearer", "DPoP"]),
  expires_in: Schema.Number,
  scope: TrimmedNonEmptyString,
});
export type AuthAccessTokenResult = typeof AuthAccessTokenResult.Type;

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

// Read models contain metadata only. Credentials are returned by creation alone.
export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  scopes: AuthEnvironmentScopes,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export class AuthAccessStreamError extends Schema.TaggedError<AuthAccessStreamError>()(
  "AuthAccessStreamError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentAuthorizationError extends Schema.TaggedError<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    message: Schema.String,
    requiredScope: AuthEnvironmentScope,
  },
) {}

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(AuthGrantScopes),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type AuthSessionState = typeof AuthSessionState.Type;

/**
 * What an agent signed in through MCP OAuth may do, least to most: only read,
 * or act on threads that never run above the given runtime mode.
 */
export const AuthMcpClientAccess = Schema.Literals([
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type AuthMcpClientAccess = typeof AuthMcpClientAccess.Type;

/** RFC 9728 metadata for an environment's `/mcp` resource. */
export const AuthMcpProtectedResourceMetadata = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  scopes_supported: Schema.Array(AuthEnvironmentScope),
  bearer_methods_supported: Schema.Array(Schema.Literal("header")),
  resource_name: Schema.String,
});
export type AuthMcpProtectedResourceMetadata = typeof AuthMcpProtectedResourceMetadata.Type;

/** RFC 8414 metadata for the authorization server MCP clients sign in through. */
export const AuthMcpAuthorizationServerMetadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  response_types_supported: Schema.Array(Schema.Literal("code")),
  grant_types_supported: Schema.Array(Schema.Literal("authorization_code")),
  code_challenge_methods_supported: Schema.Array(Schema.Literal("S256")),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  scopes_supported: Schema.Array(AuthEnvironmentScope),
  authorization_response_iss_parameter_supported: Schema.Boolean,
});
export type AuthMcpAuthorizationServerMetadata = typeof AuthMcpAuthorizationServerMetadata.Type;

/** RFC 7591 client metadata. Fields the server does not use are dropped. */
export const AuthMcpClientRegistration = Schema.Struct({
  client_name: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});
export type AuthMcpClientRegistration = typeof AuthMcpClientRegistration.Type;

export const AuthMcpRegisteredClient = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  grant_types: Schema.Array(Schema.Literal("authorization_code")),
  response_types: Schema.Array(Schema.Literal("code")),
  token_endpoint_auth_method: Schema.Literal("none"),
}).pipe(HttpApiSchema.status(201));
export type AuthMcpRegisteredClient = typeof AuthMcpRegisteredClient.Type;

/** RFC 7591 §3.2.2 registration error. */
export class AuthMcpRegistrationError extends Schema.Error<AuthMcpRegistrationError>(
  "AuthMcpRegistrationError",
)(
  {
    error: Schema.Literals(["invalid_client_metadata", "invalid_redirect_uri"]),
    error_description: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return this.error_description;
  }
}

/**
 * An agent's authorization request, as the approval page received it in its
 * URL. Every field is checked by the server, so all are optional here.
 */
export const AuthMcpAuthorizationRequest = Schema.Struct({
  response_type: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
  code_challenge: Schema.optionalKey(Schema.String),
  code_challenge_method: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String),
});
export type AuthMcpAuthorizationRequest = typeof AuthMcpAuthorizationRequest.Type;

/**
 * What the approval page needs to show for an MCP OAuth sign-in. The server
 * has already validated the request; nothing here is trusted by the client
 * except for display.
 */
export const AuthMcpApprovalDetails = Schema.Struct({
  /** Self-declared by the client, so shown as such. */
  clientName: Schema.String,
  /** Where the code goes: always a loopback address on the browser's machine. */
  redirectHost: Schema.String,
  environmentHost: Schema.String,
  /** Present when this browser's session may approve without a pairing code. */
  csrfToken: Schema.optionalKey(Schema.String),
  /**
   * What that session may approve in one click: only access whose scopes it
   * holds. Anything else still needs a pairing code. Absent with `csrfToken`.
   */
  oneClickAccess: Schema.optionalKey(Schema.Array(AuthMcpClientAccess)),
});
export type AuthMcpApprovalDetails = typeof AuthMcpApprovalDetails.Type;

/**
 * Where the approval page sends the browser next: back to the agent with a
 * code, a denial, or a protocol error the agent should receive.
 */
export const AuthMcpApprovalRedirect = Schema.Struct({
  redirectTo: Schema.String,
});
export type AuthMcpApprovalRedirect = typeof AuthMcpApprovalRedirect.Type;

export const AuthMcpApprovalDecision = Schema.Union([
  Schema.TaggedStruct("deny", {}),
  Schema.TaggedStruct("pairing-code", {
    access: AuthMcpClientAccess,
    code: TrimmedNonEmptyString,
  }),
  /** One click, for a browser session that may approve (see `csrfToken`). */
  Schema.TaggedStruct("browser-session", {
    access: AuthMcpClientAccess,
    csrfToken: Schema.String,
  }),
]);
export type AuthMcpApprovalDecision = typeof AuthMcpApprovalDecision.Type;

export const AuthMcpApprovalDecisionRequest = Schema.Struct({
  authorization: AuthMcpAuthorizationRequest,
  decision: AuthMcpApprovalDecision,
});
export type AuthMcpApprovalDecisionRequest = typeof AuthMcpApprovalDecisionRequest.Type;

/** A problem the approval page shows the user without redirecting anywhere. */
export class AuthMcpApprovalError extends Schema.TaggedError<AuthMcpApprovalError>()(
  "AuthMcpApprovalError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** RFC 6749 §4.1.3 token request. Every field is checked by the server. */
export const AuthMcpTokenRequest = Schema.Struct({
  grant_type: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  code_verifier: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthMcpTokenRequest = typeof AuthMcpTokenRequest.Type;

export const AuthMcpTokenResult = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
});
export type AuthMcpTokenResult = typeof AuthMcpTokenResult.Type;

/** RFC 6749 §5.2 token error. */
export class AuthMcpTokenError extends Schema.Error<AuthMcpTokenError>("AuthMcpTokenError")(
  {
    error: Schema.Literals([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unsupported_grant_type",
    ]),
    error_description: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return this.error_description;
  }
}
