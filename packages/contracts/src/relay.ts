import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";
import {
  EnvironmentId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { RelayAgentActivityAggregateState, RelayAgentActivityPublishErrors, RelayAgentActivityPublishRequest, RelayAuthAndInternalErrors, RelayAuthInvalidError, RelayClientBearerAuthorization, RelayDeviceRegistrationRequest, RelayDeviceUnregistrationParams, RelayEnvironmentConnectErrors, RelayEnvironmentEndpointFailure, RelayEnvironmentLinkChallengeRequest, RelayEnvironmentLinkChallengeResponse, RelayEnvironmentLinkErrors, RelayEnvironmentLinkRequest, RelayEnvironmentLinkResponse, RelayInternalError, RelayListDevicesResponse, RelayListDevicesResponseV1, RelayLiveActivityRegistrationRequest, RelayManagedEndpoint, RelayManagedEndpointRecoveryRegistrationRequest, RelayManagedEndpointRecoveryRegistrationResponse, RelayManagedEndpointRecoveryRequest, RelayManagedEndpointRecoveryResponse, RelaySignedJwtRegisteredClaims } from "./relayPart2.ts";
export {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayAgentActivityPublishProofInvalidReason,
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayAgentActivityState,
  RelayAgentAwarenessPhase,
  RelayAgentAwarenessPreferences,
  RelayAuthInvalidError,
  RelayAuthInvalidReason,
  RelayClientDeviceRecord,
  RelayDeviceRegistrationRequest,
  RelayDpopFailureReason,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentConnectNotAuthorizedReason,
  RelayEnvironmentEndpointFailure,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentLinkChallengeRequest,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkLimitExceededError,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkProofInvalidReason,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayEnvironmentLinkResponse,
  RelayEnvironmentLinkUnavailableError,
  RelayInternalError,
  RelayLinkProofRequest,
  RelayLiveActivityRegistrationRequest,
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointProviderKind,
  RelayManagedEndpointRecoveryProofPayload,
  RelayManagedEndpointRecoveryRegistrationRequest,
  RelayManagedEndpointRecoveryRegistrationResponse,
  RelayManagedEndpointRecoveryResponse,
  RelayManagedEndpointRuntimeConfig,
  RelayProtectedError,
} from "./relayPart2.ts";

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

const RelayListEnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(RelayClientEnvironmentRecord),
});
type RelayListEnvironmentsResponse = typeof RelayListEnvironmentsResponse.Type;

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

const RelayDpopAccessTokenRequest = Schema.Struct({
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
type RelayDpopAccessTokenRequest = typeof RelayDpopAccessTokenRequest.Type;

const RelayDpopAccessTokenResponse = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(RelayAccessTokenType),
  token_type: Schema.Literal("DPoP"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: TrimmedNonEmptyString,
});
type RelayDpopAccessTokenResponse = typeof RelayDpopAccessTokenResponse.Type;

const RelayBearerRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
});

const RelayDpopProofRequestHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString,
});

const RelayDpopRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
  dpop: TrimmedNonEmptyString,
});

const RelayAuthorizationServerMetadata = Schema.Struct({
  issuer: TrimmedNonEmptyString,
  token_endpoint: TrimmedNonEmptyString,
  grant_types_supported: Schema.Array(Schema.Literal(RelayDpopTokenExchangeGrantType)),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
});

const RelayProtectedResourceMetadata = Schema.Struct({
  resource: TrimmedNonEmptyString,
  authorization_servers: Schema.Array(TrimmedNonEmptyString),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
  dpop_bound_access_tokens_required: Schema.Boolean,
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
});

const RelayEnvironmentUnlinkParams = Schema.Struct({
  environmentId: EnvironmentId,
});
type RelayEnvironmentUnlinkParams = typeof RelayEnvironmentUnlinkParams.Type;

export const RelayEnvironmentConnectResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentConnectResponse = typeof RelayEnvironmentConnectResponse.Type;

const RelayEnvironmentStatusValue = Schema.Literals(["online", "offline"]);
type RelayEnvironmentStatusValue = typeof RelayEnvironmentStatusValue.Type;

const RelayEnvironmentOfflineReason = Schema.Literals(["tunnel_released"]);
type RelayEnvironmentOfflineReason = typeof RelayEnvironmentOfflineReason.Type;

export const RelayEnvironmentStatusResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  status: RelayEnvironmentStatusValue,
  checkedAt: TrimmedNonEmptyString,
  descriptor: Schema.optional(ExecutionEnvironmentDescriptor),
  error: Schema.optional(TrimmedNonEmptyString),
  endpointFailure: Schema.optional(RelayEnvironmentEndpointFailure),
  endpointStatus: Schema.optional(Schema.Number),
  offlineReason: Schema.optional(RelayEnvironmentOfflineReason),
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

const RelayCloudMintCredentialProof = TrimmedNonEmptyString;
type RelayCloudMintCredentialProof = typeof RelayCloudMintCredentialProof.Type;

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

/** Verify x-t3-relay-delivery with the relay mint key before trusting delivery id, time, or trace context. */
export const RelayHookDeliveryProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  deliveryId: TrimmedNonEmptyString,
  receivedAt: TrimmedNonEmptyString,
  hookId: TrimmedNonEmptyString,
});
export type RelayHookDeliveryProofPayload = typeof RelayHookDeliveryProofPayload.Type;

const RelayCloudEnvironmentHealthProof = TrimmedNonEmptyString;
type RelayCloudEnvironmentHealthProof = typeof RelayCloudEnvironmentHealthProof.Type;

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

export const RelayT3ChatPlan = Schema.Literals(["free", "pro", "premier"]);
export type RelayT3ChatPlan = typeof RelayT3ChatPlan.Type;

export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

// A linked paid T3 Chat plan raises the default managed tunnel cap.
export const T3CHAT_PLAN_TUNNEL_LIMITS = { pro: 10, premier: 100 } as const;

export const RelayT3ChatLink = Schema.Struct({
  email: Schema.String,
  plan: RelayT3ChatPlan,
});
export type RelayT3ChatLink = typeof RelayT3ChatLink.Type;

export const RelayT3ChatLinkResponse = Schema.Struct({
  // False when this relay has no T3 Chat secret, so clients hide the feature.
  available: Schema.Boolean,
  link: Schema.NullOr(RelayT3ChatLink),
  // A manual cap that replaces the plan's; T3 Chat upgrades do not raise it.
  maxTunnelsOverride: Schema.optionalKey(Schema.Number),
});
export type RelayT3ChatLinkResponse = typeof RelayT3ChatLinkResponse.Type;

export const RelayT3ChatLinkRequestResponse = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type RelayT3ChatLinkRequestResponse = typeof RelayT3ChatLinkRequestResponse.Type;

export const RelayPublishResponse = Schema.Struct({
  ok: Schema.Boolean,
  deliveries: Schema.Array(RelayDeliveryResult),
});
export type RelayPublishResponse = typeof RelayPublishResponse.Type;

const RelayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("relay"),
});
type RelayHealthResponse = typeof RelayHealthResponse.Type;

const RelayHealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: RelayHealthResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Check relay health"),
  )
  .annotate(OpenApi.Description, "Service health and readiness.");

const RelayMetadataGroup = HttpApiGroup.make("metadata")
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

export const RelayAgentActivitySnapshotResponse = Schema.Struct({
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
});
export type RelayAgentActivitySnapshotResponse = typeof RelayAgentActivitySnapshotResponse.Type;

export const RelayAgentActivitySnapshotEndpoint = HttpApiEndpoint.get(
  "getAgentActivitySnapshot",
  "/v1/mobile/agent-activity",
  {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentActivitySnapshotResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Read the current Live Activity aggregate");

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

const RelayMobileGroup = HttpApiGroup.make("mobile")
  .add(
    RelayRegisterDeviceEndpoint,
    RelayRegisterLiveActivityEndpoint,
    RelayAgentActivitySnapshotEndpoint,
    RelayUnregisterDeviceEndpoint,
  )
  .annotate(OpenApi.Description, "Mobile push-notification and Live Activity registration.")
  .middleware(RelayDpopClientAuth);

const RelayClientGroup = HttpApiGroup.make("client")
  .add(
    HttpApiEndpoint.get("listEnvironments", "/v1/environments", {
      headers: RelayBearerRequestHeaders,
      success: RelayListEnvironmentsResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List linked environments"),
    HttpApiEndpoint.get("listDevices", "/v1/client/devices", {
      headers: RelayBearerRequestHeaders,
      success: RelayListDevicesResponseV1,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List registered iOS devices (legacy clients)"),
    HttpApiEndpoint.get("listDevicesV2", "/v2/client/devices", {
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
    HttpApiEndpoint.delete(
      "releaseEnvironmentTunnel",
      "/v1/client/environment-links/:environmentId/tunnel",
      {
        headers: RelayBearerRequestHeaders,
        params: RelayEnvironmentUnlinkParams,
        success: RelayOkResponse,
        error: RelayAuthAndInternalErrors,
      },
    )
      .annotate(OpenApi.Summary, "Release an environment's managed tunnel")
      .annotate(
        OpenApi.Description,
        "Deletes the provisioned Cloudflare tunnel while keeping the environment link and its hostname reservation, so a later link re-provisions the tunnel under the same URL. Environments call this when they shut down; Cloudflare bills per provisioned tunnel, so idle tunnels should not outlive their environment.",
      ),
    HttpApiEndpoint.get("getT3ChatLink", "/v1/client/t3chat-link", {
      headers: RelayBearerRequestHeaders,
      success: RelayT3ChatLinkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Get the linked T3 Chat account"),
    HttpApiEndpoint.post("createT3ChatLinkRequest", "/v1/client/t3chat-link-requests", {
      headers: RelayBearerRequestHeaders,
      success: RelayT3ChatLinkRequestResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Start linking a T3 Chat account"),
    HttpApiEndpoint.delete("unlinkT3Chat", "/v1/client/t3chat-link", {
      headers: RelayBearerRequestHeaders,
      success: RelayOkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Unlink the T3 Chat account"),
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

const RelayTokenGroup = HttpApiGroup.make("token")
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

const RelayDpopClientGroup = HttpApiGroup.make("dpopClient")
  .add(RelayConnectEnvironmentEndpoint, RelayGetEnvironmentStatusEndpoint)
  .annotate(OpenApi.Description, "DPoP-authenticated client access to linked environments.")
  .middleware(RelayDpopClientAuth);

const RelayEnvironmentLinkPreferencesRequest = Schema.Struct({
  holdWebhooksWhileOffline: Schema.Boolean,
});
type RelayEnvironmentLinkPreferencesRequest =
  typeof RelayEnvironmentLinkPreferencesRequest.Type;

const RelayWakeHeldHooksResponse = Schema.Struct({
  pending: Schema.Boolean,
});
type RelayWakeHeldHooksResponse = typeof RelayWakeHeldHooksResponse.Type;

const RelayServerGroup = HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.post(
      "registerManagedEndpointRecovery",
      "/v1/environments/:environmentId/tunnel/recovery",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
        }),
        payload: RelayManagedEndpointRecoveryRegistrationRequest,
        success: RelayManagedEndpointRecoveryRegistrationResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Register managed tunnel recovery without provisioning"),
    HttpApiEndpoint.post("recoverManagedEndpoint", "/v1/environments/:environmentId/tunnel", {
      params: Schema.Struct({
        environmentId: EnvironmentId,
      }),
      payload: RelayManagedEndpointRecoveryRequest,
      success: RelayManagedEndpointRecoveryResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Recover an environment's managed tunnel"),
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
      "updateLinkPreferences",
      "/v1/environments/:environmentId/link-preferences",
      {
        params: Schema.Struct({ environmentId: EnvironmentId }),
        payload: RelayEnvironmentLinkPreferencesRequest,
        success: RelayEnvironmentLinkPreferencesRequest,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Update an environment's link preferences"),
    HttpApiEndpoint.post("wakeHeldHooks", "/v1/environments/:environmentId/hooks/wake", {
      params: Schema.Struct({ environmentId: EnvironmentId }),
      success: RelayWakeHeldHooksResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(
      OpenApi.Summary,
      "Deliver webhook requests held while the environment was offline now",
    ),
  )
  .annotate(OpenApi.Description, "Environment-authenticated activity publication.")
  .middleware(RelayEnvironmentAuth);

// Path token authenticates; forward raw bytes for signature verification.
// endpointKey is the managed endpoint hash, not the account-linkable environment id.
const RelayHookParams = Schema.Struct({
  endpointKey: Schema.String,
  hookId: Schema.String,
  token: Schema.String,
});

const RELAY_HOOK_PATH = "/v1/hooks/:endpointKey/:hookId/:token";

const relayHookEndpoint = { params: RelayHookParams } as const;

const RelayHooksGroup = HttpApiGroup.make("hooks")
  .add(
    HttpApiEndpoint.post("forwardPost", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.put("forwardPut", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.patch("forwardPatch", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.get("forwardGet", RELAY_HOOK_PATH, relayHookEndpoint),
  )
  .annotate(OpenApi.Description, "Forward webhook requests to an environment.");

export const RelayMobileTelemetrySignal = Schema.Literals(["logs", "metrics", "traces"]);
export type RelayMobileTelemetrySignal = typeof RelayMobileTelemetrySignal.Type;

// expo-observe appends `<easProjectId>/v1/<signal>` to its endpoint URL and cannot send credentials.
const RelayMobileTelemetryParams = Schema.Struct({
  projectId: Schema.String.check(Schema.isGUID()),
  signal: RelayMobileTelemetrySignal,
});

const RelayMobileTelemetryGroup = HttpApiGroup.make("mobileTelemetry")
  .add(
    HttpApiEndpoint.post("ingest", "/v1/mobile/observe/:projectId/v1/:signal", {
      params: RelayMobileTelemetryParams,
    }),
  )
  .annotate(OpenApi.Description, "Receive mobile app telemetry from expo-observe.");

export const RelayApi = HttpApi.make("RelayApi")
  .add(
    RelayHealthGroup,
    RelayMetadataGroup,
    RelayMobileGroup,
    RelayClientGroup,
    RelayTokenGroup,
    RelayDpopClientGroup,
    RelayServerGroup,
    RelayHooksGroup,
    RelayMobileTelemetryGroup,
  )
  .annotate(OpenApi.Title, "T3 Code Relay API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(
    OpenApi.Description,
    "Control-plane API for linking T3 environments, connecting authorized clients, and publishing agent activity.",
  );
export type RelayApi = typeof RelayApi;
