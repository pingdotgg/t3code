import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";

export const RelayAgentAwarenessPlatform = Schema.Literal("ios");
export type RelayAgentAwarenessPlatform = typeof RelayAgentAwarenessPlatform.Type;

export const RelayAgentAwarenessPhase = Schema.Literals([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type RelayAgentAwarenessPhase = typeof RelayAgentAwarenessPhase.Type;

// Intentional copy — keep in sync with WorkflowTicketAttentionKind in workflow.ts.
export const WorkflowTicketAttentionKind = Schema.Literals([
  "waiting_for_approval",
  "waiting_for_input",
  "blocked",
]);
export type WorkflowTicketAttentionKind = typeof WorkflowTicketAttentionKind.Type;

export const RelayAgentAwarenessPreferences = Schema.Struct({
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  notifyOnBlocked: Schema.optional(Schema.Boolean),
});
export type RelayAgentAwarenessPreferences = typeof RelayAgentAwarenessPreferences.Type;

export const RelayDeviceRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(18)),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  pushToken: Schema.optional(TrimmedNonEmptyString),
  pushToStartToken: Schema.optional(TrimmedNonEmptyString),
  preferences: RelayAgentAwarenessPreferences,
});
export type RelayDeviceRegistrationRequest = typeof RelayDeviceRegistrationRequest.Type;

export const RelayClientDeviceRecord = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(18)),
  appVersion: Schema.NullOr(TrimmedNonEmptyString),
  notifications: Schema.Struct({
    enabled: Schema.Boolean,
    notifyOnApproval: Schema.Boolean,
    notifyOnInput: Schema.Boolean,
    notifyOnCompletion: Schema.Boolean,
    notifyOnFailure: Schema.Boolean,
    notifyOnBlocked: Schema.Boolean,
  }),
  liveActivities: Schema.Struct({
    enabled: Schema.Boolean,
  }),
  updatedAt: TrimmedNonEmptyString,
});
export type RelayClientDeviceRecord = typeof RelayClientDeviceRecord.Type;

export const RelayListDevicesResponse = Schema.Struct({
  devices: Schema.Array(RelayClientDeviceRecord),
});
export type RelayListDevicesResponse = typeof RelayListDevicesResponse.Type;

export const RelayLiveActivityRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  activityPushToken: TrimmedNonEmptyString,
});
export type RelayLiveActivityRegistrationRequest = typeof RelayLiveActivityRegistrationRequest.Type;

export const RelayDeviceUnregistrationParams = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type RelayDeviceUnregistrationParams = typeof RelayDeviceUnregistrationParams.Type;

export const RelayAgentActivityState = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  headline: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  modelTitle: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityState = typeof RelayAgentActivityState.Type;

export const RelayAgentActivityAggregateRow = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  modelTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  status: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityAggregateRow = typeof RelayAgentActivityAggregateRow.Type;

export const RelayAgentActivityAggregateState = Schema.Struct({
  title: TrimmedNonEmptyString,
  subtitle: TrimmedNonEmptyString,
  activeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: TrimmedNonEmptyString,
  activities: Schema.Array(RelayAgentActivityAggregateRow),
});
export type RelayAgentActivityAggregateState = typeof RelayAgentActivityAggregateState.Type;

export const RelayManagedEndpointProviderKind = Schema.Literals([
  "manual",
  "cloudflare_tunnel",
  "t3_relay",
]);
export type RelayManagedEndpointProviderKind = typeof RelayManagedEndpointProviderKind.Type;

export const RelayManagedEndpoint = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  providerKind: RelayManagedEndpointProviderKind,
});
export type RelayManagedEndpoint = typeof RelayManagedEndpoint.Type;

export const RelayManagedEndpointOrigin = Schema.Struct({
  localHttpHost: TrimmedNonEmptyString,
  localHttpPort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
});
export type RelayManagedEndpointOrigin = typeof RelayManagedEndpointOrigin.Type;

export const RelayManagedEndpointRuntimeConfig = Schema.Struct({
  providerKind: RelayManagedEndpointProviderKind,
  connectorToken: TrimmedNonEmptyString,
  tunnelId: Schema.optional(TrimmedNonEmptyString),
  tunnelName: Schema.optional(TrimmedNonEmptyString),
});
export type RelayManagedEndpointRuntimeConfig = typeof RelayManagedEndpointRuntimeConfig.Type;

export const RelayLinkProofRequest = Schema.Struct({
  challenge: Schema.String,
  relayIssuer: Schema.String,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
});
export type RelayLinkProofRequest = typeof RelayLinkProofRequest.Type;

export const RelayEnvironmentConfigRequest = Schema.Struct({
  relayUrl: Schema.String,
  relayIssuer: Schema.optional(Schema.String),
  cloudUserId: Schema.String,
  environmentCredential: Schema.String,
  cloudMintPublicKey: Schema.String,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
});
export type RelayEnvironmentConfigRequest = typeof RelayEnvironmentConfigRequest.Type;

const RelaySignedJwtRegisteredClaims = {
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
} as const;

export const RelayAgentActivityPublishProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: Schema.NullOr(RelayAgentActivityState),
});
export type RelayAgentActivityPublishProofPayload =
  typeof RelayAgentActivityPublishProofPayload.Type;
export type RelayAgentActivityPublishProof = string;

export const RelayAgentActivityPublishRequest = Schema.Struct({
  state: Schema.NullOr(RelayAgentActivityState).annotate({
    description: "Current agent-awareness state, or null to remove the published state.",
  }),
  proof: TrimmedNonEmptyString.annotate({
    description: "Environment-signed JWT covering this published activity state.",
  }),
}).annotate({ description: "Publishes a signed agent-awareness update from an environment." });
export type RelayAgentActivityPublishRequest = typeof RelayAgentActivityPublishRequest.Type;

export const RELAY_BOARD_TICKET_PUBLISH_TYP = "t3-relay-board-ticket-publish+jwt" as const;

export const RelayBoardTicketState = Schema.Struct({
  environmentId: EnvironmentId,
  boardId: TrimmedNonEmptyString,
  ticketId: TrimmedNonEmptyString,
  attentionKind: WorkflowTicketAttentionKind,
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
  transitionId: TrimmedNonEmptyString,
});
export type RelayBoardTicketState = typeof RelayBoardTicketState.Type;

export const RelayBoardTicketPublishProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  boardId: TrimmedNonEmptyString,
  ticketId: TrimmedNonEmptyString,
  state: Schema.NullOr(RelayBoardTicketState),
});
export type RelayBoardTicketPublishProofPayload = typeof RelayBoardTicketPublishProofPayload.Type;

export const RelayBoardTicketPublishRequest = Schema.Struct({
  state: Schema.NullOr(RelayBoardTicketState),
  proof: TrimmedNonEmptyString,
});
export type RelayBoardTicketPublishRequest = typeof RelayBoardTicketPublishRequest.Type;

export const RelayEnvironmentLinkScope = Schema.Literals([
  "agent_activity_notifications",
  "managed_tunnels",
]);
export type RelayEnvironmentLinkScope = typeof RelayEnvironmentLinkScope.Type;

export const RelayEnvironmentLinkProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  challenge: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
  scopes: Schema.Array(RelayEnvironmentLinkScope),
});
export type RelayEnvironmentLinkProofPayload = typeof RelayEnvironmentLinkProofPayload.Type;

export const RelayEnvironmentLinkProof = TrimmedNonEmptyString;
export type RelayEnvironmentLinkProof = typeof RelayEnvironmentLinkProof.Type;

export const RelayEnvironmentLinkChallengeRequest = Schema.Struct({
  notificationsEnabled: Schema.Boolean.annotate({
    description: "Whether this link may deliver push notifications.",
  }),
  liveActivitiesEnabled: Schema.Boolean.annotate({
    description: "Whether this link may update Live Activities.",
  }),
  managedTunnelsEnabled: Schema.Boolean.annotate({
    description: "Whether the relay should provision a managed tunnel for this environment.",
  }),
}).annotate({ description: "Requested capabilities for a new environment-link challenge." });
export type RelayEnvironmentLinkChallengeRequest = typeof RelayEnvironmentLinkChallengeRequest.Type;

export const RelayEnvironmentLinkChallengeResponse = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkChallengeResponse =
  typeof RelayEnvironmentLinkChallengeResponse.Type;

export const RelayEnvironmentLinkRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier associated with this link.",
    }),
  ),
  proof: RelayEnvironmentLinkProof.annotate({
    description: "Environment-signed proof bound to a previously issued link challenge.",
  }),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
}).annotate({ description: "Links an authenticated cloud user to a T3 environment." });
export type RelayEnvironmentLinkRequest = typeof RelayEnvironmentLinkRequest.Type;

export const RelayEnvironmentLinkResponse = Schema.Struct({
  ok: Schema.Boolean,
  cloudUserId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  relayIssuer: TrimmedNonEmptyString,
  environmentCredential: TrimmedNonEmptyString,
  cloudMintPublicKey: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkResponse = typeof RelayEnvironmentLinkResponse.Type;

export const RelayEnvironmentLinkProofInvalidReason = Schema.Literals([
  "invalid_signature_or_scope",
  "descriptor_mismatch",
  "replayed_nonce",
  "challenge_invalid",
  "origin_not_allowed",
  "endpoint_not_secure",
]);
export type RelayEnvironmentLinkProofInvalidReason =
  typeof RelayEnvironmentLinkProofInvalidReason.Type;

export const RelayEnvironmentLinkFailedReason = Schema.Literals([
  "link_persistence_failed",
  "credential_persistence_failed",
  "replay_persistence_failed",
  "internal_error",
]);
export type RelayEnvironmentLinkFailedReason = typeof RelayEnvironmentLinkFailedReason.Type;

export const RelayEnvironmentLinkUnavailableReason = Schema.Literals([
  "managed_endpoint_not_configured",
  "managed_endpoint_provisioning_failed",
]);
export type RelayEnvironmentLinkUnavailableReason =
  typeof RelayEnvironmentLinkUnavailableReason.Type;

export const RelayEnvironmentEndpointUnavailableReason = Schema.Literals([
  "endpoint_request_failed",
  "endpoint_response_invalid",
]);
export type RelayEnvironmentEndpointUnavailableReason =
  typeof RelayEnvironmentEndpointUnavailableReason.Type;

export const RelayAgentActivityPublishProofInvalidReason = Schema.Literals([
  "invalid_signature_or_payload",
  "replayed_nonce",
]);
export type RelayAgentActivityPublishProofInvalidReason =
  typeof RelayAgentActivityPublishProofInvalidReason.Type;

export const RelayAuthInvalidReason = Schema.Literals([
  "missing_bearer",
  "invalid_bearer",
  "invalid_dpop",
  "not_authorized",
]);
export type RelayAuthInvalidReason = typeof RelayAuthInvalidReason.Type;

export const RelayInternalErrorReason = Schema.Literals([
  "database_unavailable",
  "persistence_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type RelayInternalErrorReason = typeof RelayInternalErrorReason.Type;

export class RelayAuthInvalidError extends Schema.TaggedErrorClass<RelayAuthInvalidError>()(
  "RelayAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: RelayAuthInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay authentication failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkProofExpiredError extends Schema.TaggedErrorClass<RelayEnvironmentLinkProofExpiredError>()(
  "RelayEnvironmentLinkProofExpiredError",
  {
    code: Schema.Literal("environment_link_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay environment link proof expired";
  }
}

export class RelayEnvironmentLinkProofInvalidError extends Schema.TaggedErrorClass<RelayEnvironmentLinkProofInvalidError>()(
  "RelayEnvironmentLinkProofInvalidError",
  {
    code: Schema.Literal("environment_link_proof_invalid"),
    reason: RelayEnvironmentLinkProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `Relay environment link proof is invalid: ${this.reason}`;
  }
}

export class RelayEnvironmentConnectNotAuthorizedError extends Schema.TaggedErrorClass<RelayEnvironmentConnectNotAuthorizedError>()(
  "RelayEnvironmentConnectNotAuthorizedError",
  {
    code: Schema.Literal("environment_connect_not_authorized"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Relay environment connection is not authorized";
  }
}

export class RelayEnvironmentEndpointUnavailableError extends Schema.TaggedErrorClass<RelayEnvironmentEndpointUnavailableError>()(
  "RelayEnvironmentEndpointUnavailableError",
  {
    code: Schema.Literal("environment_endpoint_unavailable"),
    reason: RelayEnvironmentEndpointUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay environment endpoint is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentEndpointTimedOutError extends Schema.TaggedErrorClass<RelayEnvironmentEndpointTimedOutError>()(
  "RelayEnvironmentEndpointTimedOutError",
  {
    code: Schema.Literal("environment_endpoint_timed_out"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  override get message(): string {
    return "Relay environment endpoint request timed out";
  }
}

export class RelayEnvironmentLinkFailedError extends Schema.TaggedErrorClass<RelayEnvironmentLinkFailedError>()(
  "RelayEnvironmentLinkFailedError",
  {
    code: Schema.Literal("environment_link_failed"),
    reason: RelayEnvironmentLinkFailedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay environment link failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkUnavailableError extends Schema.TaggedErrorClass<RelayEnvironmentLinkUnavailableError>()(
  "RelayEnvironmentLinkUnavailableError",
  {
    code: Schema.Literal("environment_link_unavailable"),
    reason: RelayEnvironmentLinkUnavailableReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Relay environment link is unavailable: ${this.reason}`;
  }
}

export class RelayAgentActivityPublishProofExpiredError extends Schema.TaggedErrorClass<RelayAgentActivityPublishProofExpiredError>()(
  "RelayAgentActivityPublishProofExpiredError",
  {
    code: Schema.Literal("agent_activity_publish_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay agent activity publish proof expired";
  }
}

export class RelayAgentActivityPublishProofInvalidError extends Schema.TaggedErrorClass<RelayAgentActivityPublishProofInvalidError>()(
  "RelayAgentActivityPublishProofInvalidError",
  {
    code: Schema.Literal("agent_activity_publish_proof_invalid"),
    reason: RelayAgentActivityPublishProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay agent activity publish proof is invalid: ${this.reason}`;
  }
}

export class RelayInternalError extends Schema.TaggedErrorClass<RelayInternalError>()(
  "RelayInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: RelayInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay internal error: ${this.reason}`;
  }
}

export const RelayProtectedError = Schema.Union([
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkUnavailableError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
]);
export type RelayProtectedError = typeof RelayProtectedError.Type;

const RelayAuthAndInternalErrors = [RelayAuthInvalidError, RelayInternalError] as const;

const RelayEnvironmentLinkErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkFailedError,
  RelayInternalError,
] as const;

const RelayEnvironmentConnectErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayInternalError,
] as const;

const RelayAgentActivityPublishErrors = [
  RelayAuthInvalidError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
] as const;

export class RelayClientPrincipal extends Context.Service<
  RelayClientPrincipal,
  {
    readonly userId: string;
    readonly token: string;
    readonly proofKeyThumbprint?: string;
    readonly dpopScopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
  }
>()("@t3tools/contracts/relay/RelayClientPrincipal") {}

export class RelayEnvironmentPrincipal extends Context.Service<
  RelayEnvironmentPrincipal,
  {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
  }
>()("@t3tools/contracts/relay/RelayEnvironmentPrincipal") {}

const RelayClientBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Clerk session or OAuth bearer token for the signed-in T3 Connect user.",
  ),
);

export class RelayClientAuth extends HttpApiMiddleware.Service<
  RelayClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayClientAuth", {
  error: RelayAuthInvalidError,
  security: { clientBearer: RelayClientBearerAuthorization },
}) {}

const RelayEnvironmentBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Relay-issued environment credential installed when the environment is linked.",
  ),
);

export class RelayEnvironmentAuth extends HttpApiMiddleware.Service<
  RelayEnvironmentAuth,
  { provides: RelayEnvironmentPrincipal }
>()("RelayEnvironmentAuth", {
  error: [RelayAuthInvalidError, RelayInternalError],
  security: { environmentBearer: RelayEnvironmentBearerAuthorization },
}) {}

const RelayDpopAuthorization = HttpApiSecurity.http({ scheme: "DPoP" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
  ),
);

export class RelayDpopClientAuth extends HttpApiMiddleware.Service<
  RelayDpopClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayDpopClientAuth", {
  error: RelayAuthInvalidError,
  security: { relayDpop: RelayDpopAuthorization },
}) {}

export const RelayClientEnvironmentRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  linkedAt: TrimmedNonEmptyString,
});
export type RelayClientEnvironmentRecord = typeof RelayClientEnvironmentRecord.Type;

export const RelayListEnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(RelayClientEnvironmentRecord),
});
export type RelayListEnvironmentsResponse = typeof RelayListEnvironmentsResponse.Type;

export const RelayEnvironmentConnectRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier requesting the connection.",
    }),
  ),
  clientKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Deprecated alias for clientProofKeyThumbprint.",
    }),
  ),
  clientProofKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "JWK thumbprint that the minted environment credential must be bound to.",
    }),
  ),
}).annotate({ description: "Requests a short-lived credential for connecting to an environment." });
export type RelayEnvironmentConnectRequest = typeof RelayEnvironmentConnectRequest.Type;

export const RelayEnvironmentConnectScope = "environment:connect" as const;
export const RelayEnvironmentStatusScope = "environment:status" as const;
export const RelayMobileRegistrationScope = "mobile:registration" as const;
export const RelayDpopAccessTokenScope = Schema.Literals([
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
]);
export type RelayDpopAccessTokenScope = typeof RelayDpopAccessTokenScope.Type;

export const RelayDpopTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const RelayJwtSubjectTokenType = "urn:ietf:params:oauth:token-type:jwt" as const;
export const RelayAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const RelayPublicClientId = Schema.Literals(["t3-mobile", "t3-web"]);
export type RelayPublicClientId = typeof RelayPublicClientId.Type;
export const RelayMobileClientId = "t3-mobile" as const;
export const RelayWebClientId = "t3-web" as const;

export const RelayDpopAccessTokenRequest = Schema.Struct({
  grant_type: Schema.Literal(RelayDpopTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString.annotate({
    description: "Clerk bearer token for the signed-in cloud user.",
  }),
  subject_token_type: Schema.Literal(RelayJwtSubjectTokenType),
  requested_token_type: Schema.Literal(RelayAccessTokenType),
  resource: TrimmedNonEmptyString.annotate({
    description: "Relay issuer URL that will receive the DPoP-bound access token.",
  }),
  scope: TrimmedNonEmptyString.annotate({
    description: "Space-separated relay scopes requested by the client.",
  }),
  client_id: RelayPublicClientId,
})
  .annotate({ description: "OAuth token exchange request for a DPoP-bound relay access token." })
  .pipe(HttpApiSchema.asFormUrlEncoded());
export type RelayDpopAccessTokenRequest = typeof RelayDpopAccessTokenRequest.Type;

export const RelayDpopAccessTokenResponse = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(RelayAccessTokenType),
  token_type: Schema.Literal("DPoP"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: TrimmedNonEmptyString,
});
export type RelayDpopAccessTokenResponse = typeof RelayDpopAccessTokenResponse.Type;

export const RelayBearerRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
});

export const RelayDpopProofRequestHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString,
});

export const RelayDpopRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
  dpop: TrimmedNonEmptyString,
});

export const RelayAuthorizationServerMetadata = Schema.Struct({
  issuer: TrimmedNonEmptyString,
  token_endpoint: TrimmedNonEmptyString,
  grant_types_supported: Schema.Array(Schema.Literal(RelayDpopTokenExchangeGrantType)),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
});

export const RelayProtectedResourceMetadata = Schema.Struct({
  resource: TrimmedNonEmptyString,
  authorization_servers: Schema.Array(TrimmedNonEmptyString),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
  dpop_bound_access_tokens_required: Schema.Boolean,
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
});

export const RelayEnvironmentUnlinkParams = Schema.Struct({
  environmentId: EnvironmentId,
});
export type RelayEnvironmentUnlinkParams = typeof RelayEnvironmentUnlinkParams.Type;

export const RelayEnvironmentConnectResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentConnectResponse = typeof RelayEnvironmentConnectResponse.Type;

export const RelayEnvironmentStatusValue = Schema.Literals(["online", "offline"]);
export type RelayEnvironmentStatusValue = typeof RelayEnvironmentStatusValue.Type;

export const RelayEnvironmentStatusResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  status: RelayEnvironmentStatusValue,
  checkedAt: TrimmedNonEmptyString,
  descriptor: Schema.optional(ExecutionEnvironmentDescriptor),
  error: Schema.optional(TrimmedNonEmptyString),
  traceId: Schema.optional(TrimmedNonEmptyString),
});
export type RelayEnvironmentStatusResponse = typeof RelayEnvironmentStatusResponse.Type;

export const RelayCloudMintCredentialProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  cnf: Schema.Struct({
    jkt: TrimmedNonEmptyString,
  }),
  deviceId: Schema.optional(TrimmedNonEmptyString),
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:connect")),
});
export type RelayCloudMintCredentialProofPayload = typeof RelayCloudMintCredentialProofPayload.Type;

export const RelayCloudMintCredentialProof = TrimmedNonEmptyString;
export type RelayCloudMintCredentialProof = typeof RelayCloudMintCredentialProof.Type;

export const RelayCloudMintCredentialRequest = Schema.Struct({
  proof: RelayCloudMintCredentialProof,
});
export type RelayCloudMintCredentialRequest = typeof RelayCloudMintCredentialRequest.Type;

export const RelayCloudEnvironmentHealthProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:status")),
});
export type RelayCloudEnvironmentHealthProofPayload =
  typeof RelayCloudEnvironmentHealthProofPayload.Type;

export const RelayCloudEnvironmentHealthProof = TrimmedNonEmptyString;
export type RelayCloudEnvironmentHealthProof = typeof RelayCloudEnvironmentHealthProof.Type;

export const RelayCloudEnvironmentHealthRequest = Schema.Struct({
  proof: RelayCloudEnvironmentHealthProof,
});
export type RelayCloudEnvironmentHealthRequest = typeof RelayCloudEnvironmentHealthRequest.Type;

export const RelayEnvironmentHealthResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  requestNonce: TrimmedNonEmptyString,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponseProofPayload =
  typeof RelayEnvironmentHealthResponseProofPayload.Type;

export const RelayEnvironmentHealthResponse = Schema.Struct({
  environmentId: EnvironmentId,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponse = typeof RelayEnvironmentHealthResponse.Type;

export const RelayEnvironmentMintResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  requestNonce: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponseProofPayload =
  typeof RelayEnvironmentMintResponseProofPayload.Type;

export const RelayEnvironmentMintResponse = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponse = typeof RelayEnvironmentMintResponse.Type;

export const RelayDeliveryKind = Schema.Literals([
  "live_activity_start",
  "live_activity_update",
  "live_activity_end",
  "push_notification",
]);
export type RelayDeliveryKind = typeof RelayDeliveryKind.Type;

export const RelayDeliveryResult = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  kind: RelayDeliveryKind,
  ok: Schema.Boolean,
  queued: Schema.optional(Schema.Boolean),
  apnsStatus: Schema.NullOr(Schema.Number),
  apnsReason: Schema.NullOr(Schema.String),
  apnsId: Schema.NullOr(Schema.String),
});
export type RelayDeliveryResult = typeof RelayDeliveryResult.Type;

export const RelayOkResponse = Schema.Struct({
  ok: Schema.Boolean,
});
export type RelayOkResponse = typeof RelayOkResponse.Type;

export const RelayPublishResponse = Schema.Struct({
  ok: Schema.Boolean,
  deliveries: Schema.Array(RelayDeliveryResult),
});
export type RelayPublishResponse = typeof RelayPublishResponse.Type;

export const RelayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("relay"),
});
export type RelayHealthResponse = typeof RelayHealthResponse.Type;

export const RelayHealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: RelayHealthResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Check relay health"),
  )
  .annotate(OpenApi.Description, "Service health and readiness.");

export const RelayMetadataGroup = HttpApiGroup.make("metadata")
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: RelayAuthorizationServerMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth authorization-server metadata"),
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: RelayProtectedResourceMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth protected-resource metadata"),
  )
  .annotate(OpenApi.Description, "OAuth and DPoP discovery metadata.");

export const RelayRegisterDeviceEndpoint = HttpApiEndpoint.post(
  "registerDevice",
  "/v1/mobile/devices",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayDeviceRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register or update a mobile device");

export const RelayRegisterLiveActivityEndpoint = HttpApiEndpoint.post(
  "registerLiveActivity",
  "/v1/mobile/live-activities",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayLiveActivityRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register a Live Activity push token");

export const RelayUnregisterDeviceEndpoint = HttpApiEndpoint.delete(
  "unregisterDevice",
  "/v1/mobile/devices/:deviceId",
  {
    headers: RelayDpopRequestHeaders,
    params: RelayDeviceUnregistrationParams,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Unregister a mobile device");

export const RelayMobileGroup = HttpApiGroup.make("mobile")
  .add(
    RelayRegisterDeviceEndpoint,
    RelayRegisterLiveActivityEndpoint,
    RelayUnregisterDeviceEndpoint,
  )
  .annotate(OpenApi.Description, "Mobile push-notification and Live Activity registration.")
  .middleware(RelayDpopClientAuth);

export const RelayClientGroup = HttpApiGroup.make("client")
  .add(
    HttpApiEndpoint.get("listEnvironments", "/v1/environments", {
      headers: RelayBearerRequestHeaders,
      success: RelayListEnvironmentsResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List linked environments"),
    HttpApiEndpoint.get("listDevices", "/v1/client/devices", {
      headers: RelayBearerRequestHeaders,
      success: RelayListDevicesResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List registered mobile devices"),
    HttpApiEndpoint.post("linkEnvironment", "/v1/client/environment-links", {
      headers: RelayBearerRequestHeaders,
      payload: RelayEnvironmentLinkRequest,
      success: RelayEnvironmentLinkResponse,
      error: RelayEnvironmentLinkErrors,
    }).annotate(OpenApi.Summary, "Link an environment"),
    HttpApiEndpoint.post(
      "createEnvironmentLinkChallenge",
      "/v1/client/environment-link-challenges",
      {
        headers: RelayBearerRequestHeaders,
        payload: RelayEnvironmentLinkChallengeRequest,
        success: RelayEnvironmentLinkChallengeResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Create an environment-link challenge"),
    HttpApiEndpoint.delete("unlinkEnvironment", "/v1/client/environment-links/:environmentId", {
      headers: RelayBearerRequestHeaders,
      params: RelayEnvironmentUnlinkParams,
      success: RelayOkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Unlink an environment"),
  )
  .annotate(OpenApi.Description, "Cloud-user environment links and registered devices.")
  .middleware(RelayClientAuth);

export const RelayExchangeDpopAccessTokenEndpoint = HttpApiEndpoint.post(
  "exchangeDpopAccessToken",
  "/v1/client/dpop-token",
  {
    headers: RelayDpopProofRequestHeaders,
    payload: RelayDpopAccessTokenRequest,
    success: RelayDpopAccessTokenResponse,
    error: RelayAuthAndInternalErrors,
  },
)
  .annotate(OpenApi.Summary, "Exchange a Clerk token for a DPoP access token")
  .annotate(
    OpenApi.Description,
    "Bootstrap endpoint. Send the DPoP proof JWT in the dpop header and the Clerk token in subject_token. The returned access token is bound to the proof key.",
  );

export const RelayTokenGroup = HttpApiGroup.make("token")
  .add(RelayExchangeDpopAccessTokenEndpoint)
  .annotate(OpenApi.Description, "OAuth token exchange for DPoP-bound client access.");

export const RelayConnectEnvironmentEndpoint = HttpApiEndpoint.post(
  "connectEnvironment",
  "/v1/environments/:environmentId/connect",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    payload: RelayEnvironmentConnectRequest,
    success: RelayEnvironmentConnectResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Connect to an environment");

export const RelayGetEnvironmentStatusEndpoint = HttpApiEndpoint.post(
  "getEnvironmentStatus",
  "/v1/environments/:environmentId/status",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    success: RelayEnvironmentStatusResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Check environment status");

export const RelayDpopClientGroup = HttpApiGroup.make("dpopClient")
  .add(RelayConnectEnvironmentEndpoint, RelayGetEnvironmentStatusEndpoint)
  .annotate(OpenApi.Description, "DPoP-authenticated client access to linked environments.")
  .middleware(RelayDpopClientAuth);

export const RelayServerGroup = HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.post(
      "publishAgentActivity",
      "/v1/environments/:environmentId/threads/:threadId/agent-activity",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
          threadId: ThreadId,
        }),
        payload: RelayAgentActivityPublishRequest,
        success: RelayPublishResponse,
        error: RelayAgentActivityPublishErrors,
      },
    ).annotate(OpenApi.Summary, "Publish agent activity"),
    HttpApiEndpoint.post(
      "publishBoardTicket",
      "/v1/environments/:environmentId/tickets/:ticketId/board-activity",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
          ticketId: TrimmedNonEmptyString,
        }),
        payload: RelayBoardTicketPublishRequest,
        success: RelayPublishResponse,
        error: RelayAgentActivityPublishErrors,
      },
    ).annotate(OpenApi.Summary, "Publish board ticket attention"),
  )
  .annotate(OpenApi.Description, "Environment-authenticated activity publication.")
  .middleware(RelayEnvironmentAuth);

export const RelayApi = HttpApi.make("RelayApi")
  .add(
    RelayHealthGroup,
    RelayMetadataGroup,
    RelayMobileGroup,
    RelayClientGroup,
    RelayTokenGroup,
    RelayDpopClientGroup,
    RelayServerGroup,
  )
  .annotate(OpenApi.Title, "T3 Code Relay API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(
    OpenApi.Description,
    "Control-plane API for linking T3 environments, connecting authorized clients, and publishing agent activity.",
  );
export type RelayApi = typeof RelayApi;
