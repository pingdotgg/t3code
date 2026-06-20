import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
} from "./orchestration.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_dispatch_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedErrorClass<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedErrorClass<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedErrorClass<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export const EnvironmentHttpBadRequestReason = Schema.Literals([
  "invalid_cloud_mint_public_key",
  "invalid_relay_url",
  "invalid_relay_issuer",
  "missing_relay_environment_credential",
  "missing_cloud_user_id",
  "invalid_managed_endpoint_origin",
  "invalid_local_environment_origin",
]);
export type EnvironmentHttpBadRequestReason = typeof EnvironmentHttpBadRequestReason.Type;

const environmentHttpBadRequestMessages = {
  invalid_cloud_mint_public_key: "Cloud mint public key must be a valid Ed25519 public key.",
  invalid_relay_url: "Relay URL must be a secure absolute HTTPS URL.",
  invalid_relay_issuer: "Relay issuer must be a secure absolute HTTPS URL.",
  missing_relay_environment_credential: "Relay environment credential is required.",
  missing_cloud_user_id: "Cloud user id is required.",
  invalid_managed_endpoint_origin: "Invalid managed endpoint origin.",
  invalid_local_environment_origin: "Could not resolve local environment origin.",
} satisfies Record<EnvironmentHttpBadRequestReason, string>;

export const EnvironmentHttpUnauthorizedReason = Schema.Literals([
  "cloud_cli_authorization_required",
  "invalid_cloud_health_request",
  "invalid_cloud_mint_request",
]);
export type EnvironmentHttpUnauthorizedReason = typeof EnvironmentHttpUnauthorizedReason.Type;

const environmentHttpUnauthorizedMessages = {
  cloud_cli_authorization_required: "Run `t3 connect link` to authorize this environment.",
  invalid_cloud_health_request: "Invalid cloud health request.",
  invalid_cloud_mint_request: "Invalid cloud mint request.",
} satisfies Record<EnvironmentHttpUnauthorizedReason, string>;

export const EnvironmentHttpInternalOperation = Schema.Literals([
  "generate_link_proof",
  "verify_linked_cloud_account",
  "persist_relay_configuration",
  "persist_desired_link_state",
  "read_relay_configuration",
  "remove_relay_configuration",
  "persist_cloud_preferences",
  "answer_cloud_health_request",
  "issue_cloud_connection_credential",
  "read_linked_cloud_account",
  "require_linked_cloud_account",
  "sign_cloud_link_jwt",
  "read_cloud_mint_public_key",
  "read_cloud_relay_issuer",
  "sign_cloud_health_jwt",
  "sign_cloud_mint_jwt",
  "create_cloud_pairing_link",
  "read_relay_url_configuration",
  "relay_request",
  "remove_cloud_cli_credential",
  "refresh_cloud_cli_credential",
  "read_cloud_cli_credential",
  "authorize_cloud_cli",
  "await_cloud_cli_authorization",
]);
export type EnvironmentHttpInternalOperation = typeof EnvironmentHttpInternalOperation.Type;

export const EnvironmentHttpRelayOperation = Schema.Literals([
  "create-link-challenge",
  "create-environment-link",
]);
export type EnvironmentHttpRelayOperation = typeof EnvironmentHttpRelayOperation.Type;

export const EnvironmentHttpRelayPhase = Schema.Literals([
  "encode-request",
  "send-request",
  "check-response-status",
  "decode-response",
]);
export type EnvironmentHttpRelayPhase = typeof EnvironmentHttpRelayPhase.Type;

const environmentHttpInternalMessages = {
  generate_link_proof: "Could not generate environment link proof.",
  verify_linked_cloud_account: "Could not verify the linked cloud account.",
  persist_relay_configuration: "Could not persist environment relay configuration.",
  persist_desired_link_state: "Could not persist desired T3 Connect link state.",
  read_relay_configuration: "Could not read environment relay configuration.",
  remove_relay_configuration: "Could not remove environment relay configuration.",
  persist_cloud_preferences: "Could not persist environment cloud preferences.",
  answer_cloud_health_request: "Could not answer cloud health request.",
  issue_cloud_connection_credential: "Could not issue cloud connection credential.",
  read_linked_cloud_account: "Could not read the linked cloud account.",
  require_linked_cloud_account: "Cloud linked user is not installed for this environment.",
  sign_cloud_link_jwt: "Failed to sign cloud link JWT.",
  read_cloud_mint_public_key: "Cloud mint public key is not installed for this environment.",
  read_cloud_relay_issuer: "Cloud relay issuer is not installed for this environment.",
  sign_cloud_health_jwt: "Failed to sign cloud health JWT.",
  sign_cloud_mint_jwt: "Failed to sign cloud mint JWT.",
  create_cloud_pairing_link: "Failed to create pairing link.",
  read_relay_url_configuration:
    "T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
  remove_cloud_cli_credential: "Could not remove the stored T3 Connect CLI credential.",
  refresh_cloud_cli_credential: "Could not refresh the T3 Connect CLI credential.",
  read_cloud_cli_credential: "Could not read the stored T3 Connect CLI credential.",
  authorize_cloud_cli: "Could not authorize the T3 Connect CLI.",
  await_cloud_cli_authorization: "Timed out waiting for T3 Connect authorization.",
} satisfies Record<Exclude<EnvironmentHttpInternalOperation, "relay_request">, string>;

export const EnvironmentHttpConflictReason = Schema.Literals([
  "linked_to_different_cloud_account",
  "cloud_health_request_replayed",
  "cloud_mint_request_replayed",
]);
export type EnvironmentHttpConflictReason = typeof EnvironmentHttpConflictReason.Type;

const environmentHttpConflictMessages = {
  linked_to_different_cloud_account:
    "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
  cloud_health_request_replayed: "Cloud health request was already consumed.",
  cloud_mint_request_replayed: "Cloud mint request was already consumed.",
} satisfies Record<EnvironmentHttpConflictReason, string>;

// These HTTP errors cross independently deployed clients, relays, and environment servers. Keep
// newly added diagnostics optional while decoding so a newer peer can still consume the legacy
// message-only payload. The constructors below continue to require structured context from new
// application code and only preserve `message` when Schema is decoding an older wire payload.
function decodedEnvironmentHttpErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    reason: Schema.optional(EnvironmentHttpBadRequestReason),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: EnvironmentHttpBadRequestReason;
    readonly cause?: unknown;
  }) {
    super({
      reason: props.reason,
      message:
        decodedEnvironmentHttpErrorMessage(props) ??
        environmentHttpBadRequestMessages[props.reason],
      ...(props.cause === undefined ? {} : { cause: props.cause }),
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    reason: Schema.optional(EnvironmentHttpUnauthorizedReason),
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: EnvironmentHttpUnauthorizedReason;
    readonly cause?: unknown;
  }) {
    super({
      reason: props.reason,
      message:
        decodedEnvironmentHttpErrorMessage(props) ??
        environmentHttpUnauthorizedMessages[props.reason],
      ...(props.cause === undefined ? {} : { cause: props.cause }),
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: { readonly cause?: unknown } = {}) {
    super({
      message: decodedEnvironmentHttpErrorMessage(props) ?? "Cloud operation is forbidden.",
      ...(props.cause === undefined ? {} : { cause: props.cause }),
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    operation: Schema.optional(EnvironmentHttpInternalOperation),
    relayOperation: Schema.optional(EnvironmentHttpRelayOperation),
    relayPhase: Schema.optional(EnvironmentHttpRelayPhase),
    responseStatus: Schema.optional(Schema.Number),
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props:
      | {
          readonly operation: Exclude<EnvironmentHttpInternalOperation, "relay_request">;
          readonly cause?: unknown;
        }
      | {
          readonly operation: "relay_request";
          readonly relayOperation: EnvironmentHttpRelayOperation;
          readonly relayPhase: EnvironmentHttpRelayPhase;
          readonly responseStatus?: number;
          readonly cause?: unknown;
        },
  ) {
    const message =
      decodedEnvironmentHttpErrorMessage(props) ??
      (props.operation === "relay_request"
        ? `T3 Connect relay ${props.relayOperation} failed during ${props.relayPhase}${
            props.responseStatus === undefined
              ? ""
              : ` with response status ${props.responseStatus}`
          }.`
        : environmentHttpInternalMessages[props.operation]);
    super({
      ...props,
      message,
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedErrorClass<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    reason: Schema.optional(EnvironmentHttpConflictReason),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: { readonly reason: EnvironmentHttpConflictReason; readonly cause?: unknown }) {
    super({
      reason: props.reason,
      message:
        decodedEnvironmentHttpErrorMessage(props) ?? environmentHttpConflictMessages[props.reason],
      ...(props.cause === undefined ? {} : { cause: props.cause }),
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedErrorClass<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: { readonly endpointRuntimeStatus: unknown; readonly cause?: unknown }) {
    super({
      ...props,
      message:
        decodedEnvironmentHttpErrorMessage(props) ??
        "Managed endpoint runtime could not be started.",
    } as any);
  }

  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentConnectHttpApi) {}
