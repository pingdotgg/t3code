import { verifyToken } from "@clerk/backend";
import { sql as drizzleSql } from "drizzle-orm";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Tracer from "effect/Tracer";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";

import {
  RelayApi,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayAccessTokenType,
  RelayDpopClientAuth,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
  RelayAuthInvalidError,
  type RelayAuthInvalidReason,
  RelayEnvironmentAuth,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentPrincipal,
  type RelayEnvironmentConnectRequest,
  type RelayDpopAccessTokenScope,
  RelayInternalError,
} from "@t3tools/contracts/relay";
import { normalizeRelayIssuer } from "@t3tools/shared/relayJwt";

import { verifyAndConsumeDpopProof } from "./dpop.ts";
import * as DeliveryAttempts from "./persistence/DeliveryAttempts.ts";
import * as AgentActivityRows from "./persistence/AgentActivityRows.ts";
import * as Devices from "./persistence/Devices.ts";
import * as DpopProofs from "./persistence/DpopProofs.ts";
import * as EnvironmentCredentials from "./persistence/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./persistence/EnvironmentLinks.ts";
import * as LiveActivities from "./persistence/LiveActivities.ts";
import * as Settings from "./settings.ts";
import { increment, relayEnvironmentLinksTotal } from "./observability/Metrics.ts";
import * as AgentActivityPublisher from "./services/AgentActivityPublisher.ts";
import * as EnvironmentConnector from "./services/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./services/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./services/EnvironmentPublishSignatures.ts";
import * as MobileRegistrations from "./services/MobileRegistrations.ts";
import { RelayDb } from "./db.ts";
import {
  issueDpopAccessToken,
  issueLinkChallengeToken,
  resolveDpopAccessTokenScopes,
  verifyDpopAccessToken,
} from "./relayTokens.ts";

export const RelayHttpPlatformLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayCorsAllowedMethods = ["GET", "POST", "DELETE", "OPTIONS"] as const;
const relayCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
] as const;
const relayCorsExposedHeaders = ["x-t3-relay-auth-failure", "www-authenticate"] as const;

const relayCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": relayCorsExposedHeaders.join(","),
} as const;

export const relayCorsPreflightHeaders = {
  ...relayCorsHeaders,
  "access-control-allow-methods": relayCorsAllowedMethods.join(","),
  "access-control-allow-headers": relayCorsAllowedHeaders.join(","),
  "access-control-max-age": "86400",
} as const;

const appendRelayCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        pragma: "no-cache",
      }),
    ),
);

const appendRelayDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 401
      ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
      : response,
  ),
);

export const relayCors = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({
          status: 204,
          headers: relayCorsPreflightHeaders,
        });
      }
      const response = yield* httpEffect;
      return HttpServerResponse.setHeaders(response, relayCorsHeaders);
    }),
  { global: true },
);

export const traceRelayHttpRequest = <E, R>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
  tracer: Tracer.Tracer,
) => HttpMiddleware.tracer(httpEffect).pipe(Effect.withTracer(tracer));

export const relayClientAuthLayer = Layer.effect(
  RelayClientAuth,
  Effect.gen(function* () {
    const settings = yield* Settings.Settings;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const token = Redacted.value(credential);
          const verified = yield* verifyClerkBearerToken(settings, token).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("relay clerk token verification failed", {
                reason: clerkVerificationFailureReason(error.cause),
              }),
            ),
            Effect.catch(() => relayAuthInvalidError("invalid_bearer")),
          );
          if (!verified.sub) {
            return yield* relayAuthInvalidError("invalid_bearer");
          }
          yield* Effect.annotateCurrentSpan({ "relay.auth.subject": verified.sub });
          return yield* httpEffect.pipe(
            Effect.provideService(RelayClientPrincipal, {
              userId: verified.sub,
              token,
            }),
          );
        }),
    };
  }),
);

export const relayEnvironmentAuthLayer = Layer.effect(
  RelayEnvironmentAuth,
  Effect.gen(function* () {
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const token = Redacted.value(credential);
          const principal = yield* credentials
            .authenticate(token)
            .pipe(Effect.catch(() => relayAuthInvalidError("not_authorized")));
          if (principal._tag === "None") {
            return yield* relayAuthInvalidError("not_authorized");
          }
          yield* Effect.annotateCurrentSpan({
            "relay.environment_id": principal.value.environmentId,
          });
          return yield* httpEffect.pipe(
            Effect.provideService(RelayEnvironmentPrincipal, principal.value),
          );
        }),
    };
  }),
);

export const relayDpopClientAuthLayer = Layer.effect(
  RelayDpopClientAuth,
  Effect.gen(function* () {
    const settings = yield* Settings.Settings;
    return {
      relayDpop: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          yield* appendRelayDpopChallengeHeader;
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (!isDpopAuthorizationHeader(request.headers.authorization)) {
            return yield* relayAuthInvalidError("invalid_bearer");
          }
          // Effect beta.73 exposes arbitrary HTTP schemes but currently leaves
          // the separating spaces in the decoded credential.
          const token = Redacted.value(credential).trimStart();
          const now = yield* DateTime.now;
          const verified = yield* verifyDpopAccessToken({
            settings,
            token,
            nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
          });
          if (!verified) {
            return yield* relayAuthInvalidError("invalid_bearer");
          }
          yield* Effect.annotateCurrentSpan({ "relay.auth.subject": verified.sub });
          return yield* httpEffect.pipe(
            Effect.provideService(RelayClientPrincipal, {
              userId: verified.sub,
              token,
              proofKeyThumbprint: verified.cnf.jkt,
              dpopScopes: verified.scope,
            }),
          );
        }),
    };
  }),
);

export function isDpopAuthorizationHeader(value: string | undefined): boolean {
  return /^DPoP +/iu.test(value ?? "");
}

export const metadataApi = HttpApiBuilder.group(RelayApi, "metadata", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* Settings.Settings;
    const issuer = normalizeRelayIssuer(settings.relayIssuer);
    const scopes = [
      RelayEnvironmentConnectScope,
      RelayEnvironmentStatusScope,
      RelayMobileRegistrationScope,
    ] as const;
    return handlers
      .handle("authorizationServer", () =>
        Effect.succeed({
          issuer,
          token_endpoint: `${issuer}/v1/client/dpop-token`,
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"] as const,
          token_endpoint_auth_methods_supported: ["none"] as const,
          dpop_signing_alg_values_supported: ["ES256"] as const,
          scopes_supported: scopes,
        }),
      )
      .handle("protectedResource", () =>
        Effect.succeed({
          resource: issuer,
          authorization_servers: [issuer],
          scopes_supported: scopes,
          dpop_bound_access_tokens_required: true,
          dpop_signing_alg_values_supported: ["ES256"] as const,
        }),
      );
  }),
);

export const healthApi = HttpApiBuilder.group(RelayApi, "health", (handlers) =>
  Effect.gen(function* () {
    const db = yield* RelayDb;
    return handlers.handle(
      "health",
      Effect.fn("relay.api.health")(
        function* (args) {
          yield* annotateRelayRequest(args.endpoint.name);
          const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          yield* db
            .execute(drizzleSql`SELECT 1`)
            .pipe(Effect.withSpan("relay.api.health.db_probe"));
          const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          yield* Effect.logInfo("relay health db probe completed", {
            durationMs: completedAt - startedAt,
          });
          return { ok: true, service: "relay" as const };
        },
        Effect.catch(() => relayInternalErrorResponse("database_unavailable")),
      ),
    );
  }),
);

export const mobileApi = HttpApiBuilder.group(RelayApi, "mobile", (handlers) =>
  Effect.gen(function* () {
    const registrations = yield* MobileRegistrations.MobileRegistrations;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "registerDevice",
        Effect.fn("relay.api.mobile.registerDevice")(function* (args) {
          const { payload } = args;
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, dpopProofs, {
            expectedAccessToken: token,
          });
          return yield* registrations.registerDevice({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "registerLiveActivity",
        Effect.fn("relay.api.mobile.registerLiveActivity")(function* (args) {
          const { payload } = args;
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, dpopProofs, {
            expectedAccessToken: token,
          });
          return yield* registrations.registerLiveActivity({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "unregisterDevice",
        Effect.fn("relay.api.mobile.unregisterDevice")(function* (args) {
          const { params } = args;
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, dpopProofs, {
            expectedAccessToken: token,
          });
          return yield* registrations.unregisterDevice({ userId, deviceId: params.deviceId });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      );
  }),
);

export const clientApi = HttpApiBuilder.group(RelayApi, "client", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* Settings.Settings;
    const crypto = yield* Crypto.Crypto;
    const linker = yield* EnvironmentLinker.EnvironmentLinker;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    return handlers
      .handle(
        "listEnvironments",
        Effect.fn("relay.api.client.listEnvironments")(function* (args) {
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId } = yield* RelayClientPrincipal;
          const environments = yield* links.listForUser({ userId });
          return { environments };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "linkEnvironment",
        Effect.fn("relay.api.client.linkEnvironment")(
          function* (args) {
            const { payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            yield* annotateRelayRequest(args.endpoint.name);
            const { userId } = yield* RelayClientPrincipal;
            const result = yield* linker.link({ userId, request: payload });
            return {
              ok: true,
              cloudUserId: userId,
              environmentId: result.environmentId,
              endpoint: result.endpoint,
              endpointRuntime: result.endpointRuntime,
              relayIssuer: settings.relayIssuer,
              environmentCredential: result.environmentCredential,
              cloudMintPublicKey: Redacted.value(settings.cloudMintPublicKey),
            };
          },
          mapRelayCommonApiErrors("not_authorized"),
          mapErrorTags({
            EnvironmentLinkProofExpired: (_error, traceId) =>
              new RelayEnvironmentLinkProofExpiredError({
                code: "environment_link_proof_expired",
                traceId,
              }),
            EnvironmentLinkProofInvalid: (linkError, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: linkError.reason,
                traceId,
              }),
            ManagedEndpointProvisioningNotConfigured: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_not_configured",
                traceId,
              }),
            ManagedEndpointProvisioningFailed: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_provisioning_failed",
                traceId,
              }),
            ManagedEndpointOriginNotAllowed: (_error, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: "origin_not_allowed",
                traceId,
              }),
            EnvironmentLinkUpsertPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "link_persistence_failed",
                traceId,
              }),
            EnvironmentCredentialCreatePersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "credential_persistence_failed",
                traceId,
              }),
            DpopProofReplayPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "replay_persistence_failed",
                traceId,
              }),
          }),
        ),
      )
      .handle(
        "createEnvironmentLinkChallenge",
        Effect.fn("relay.api.client.createEnvironmentLinkChallenge")(function* (args) {
          yield* appendRelayCredentialResponseHeaders;
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId } = yield* RelayClientPrincipal;
          const now = yield* DateTime.now;
          const expiresAt = DateTime.add(now, { minutes: 5 });
          const jti = yield* crypto.randomUUIDv4.pipe(
            Effect.catch(() => relayInternalErrorResponse("internal_error")),
          );
          const challenge = yield* issueLinkChallengeToken({
            settings,
            userId,
            request: args.payload,
            jti,
            issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
            expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
          }).pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          return { challenge, expiresAt: DateTime.formatIso(expiresAt) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "unlinkEnvironment",
        Effect.fn("relay.api.client.unlinkEnvironment")(function* (args) {
          const { params } = args;
          yield* annotateRelayRequest(args.endpoint.name);
          const { userId } = yield* RelayClientPrincipal;
          const link = yield* links.getForUser({
            userId,
            environmentId: params.environmentId,
          });
          if (link === null) {
            return { ok: false };
          }
          const unlinked = yield* links.revokeForUser({
            userId,
            environmentId: params.environmentId,
          });
          if (unlinked) {
            yield* increment(relayEnvironmentLinksTotal, {
              operation: "unlink",
              endpointProviderKind: link.endpoint.providerKind,
            });
            yield* credentials.revokeForEnvironmentPublicKey({
              environmentId: link.environmentId,
              environmentPublicKey: link.environmentPublicKey,
            });
          }
          return { ok: unlinked };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const tokenApi = HttpApiBuilder.group(RelayApi, "token", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* Settings.Settings;
    const crypto = yield* Crypto.Crypto;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers.handle(
      "exchangeDpopAccessToken",
      Effect.fn("relay.api.token.exchangeDpopAccessToken")(function* (args) {
        yield* appendRelayCredentialResponseHeaders;
        yield* annotateRelayRequest(args.endpoint.name);
        const issuer = normalizeRelayIssuer(settings.relayIssuer);
        const requestedScopes = resolveDpopAccessTokenScopes({
          clientId: args.payload.client_id,
          scope: args.payload.scope,
        });
        if (args.payload.resource !== issuer || requestedScopes === null) {
          return yield* new HttpApiError.Unauthorized({});
        }
        const verified = yield* verifyClerkBearerToken(settings, args.payload.subject_token).pipe(
          Effect.catch(() => relayAuthInvalidError("invalid_bearer")),
        );
        if (!verified.sub) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        const proofKeyThumbprint = yield* requireDpopProof(dpopProofs);
        const now = yield* DateTime.now;
        const expiresAt = DateTime.add(now, { minutes: 5 });
        const jti = yield* crypto.randomUUIDv4.pipe(
          Effect.catch(() => relayInternalErrorResponse("internal_error")),
        );
        return {
          access_token: yield* issueDpopAccessToken({
            settings,
            userId: verified.sub,
            proofKeyThumbprint,
            jti,
            issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
            expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
            clientId: args.payload.client_id,
            scopes: requestedScopes,
          }).pipe(Effect.catch(() => relayInternalErrorResponse("internal_error"))),
          issued_token_type: RelayAccessTokenType,
          token_type: "DPoP" as const,
          expires_in: 300,
          scope: encodeOAuthScope(requestedScopes),
        };
      }, mapRelayCommonApiErrors("invalid_dpop")),
    );
  }),
);

export const dpopClientApi = HttpApiBuilder.group(RelayApi, "dpopClient", (handlers) =>
  Effect.gen(function* () {
    const connector = yield* EnvironmentConnector.EnvironmentConnector;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "connectEnvironment",
        Effect.fn("relay.api.dpopClient.connectEnvironment")(
          function* (args) {
            const { params, payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            yield* annotateRelayRequest(args.endpoint.name);
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:connect");
            const requestedThumbprint = resolveConnectClientKeyThumbprint(payload);
            if (!requestedThumbprint || requestedThumbprint !== proofKeyThumbprint) {
              return yield* new HttpApiError.Unauthorized({});
            }
            const clientProofKeyThumbprint = yield* requireDpopThumbprint(
              proofKeyThumbprint,
              dpopProofs,
              { expectedAccessToken: token },
            );
            return yield* connector.connect({
              userId,
              environmentId: params.environmentId,
              clientProofKeyThumbprint,
              ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (_error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      )
      .handle(
        "getEnvironmentStatus",
        Effect.fn("relay.api.dpopClient.getEnvironmentStatus")(
          function* (args) {
            const { params } = args;
            yield* annotateRelayRequest(args.endpoint.name);
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:status");
            yield* requireDpopThumbprint(proofKeyThumbprint, dpopProofs, {
              expectedAccessToken: token,
            });
            return yield* connector.status({
              userId,
              environmentId: params.environmentId,
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (_error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      );
  }),
);

export const serverApi = HttpApiBuilder.group(RelayApi, "server", (handlers) =>
  Effect.gen(function* () {
    const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
    const publishSignatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
    return handlers.handle(
      "publishAgentActivity",
      Effect.fn("relay.api.server.publishAgentActivity")(
        function* (args) {
          const { params, payload } = args;
          yield* annotateRelayRequest(args.endpoint.name);
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new HttpApiError.Unauthorized({});
          }
          yield* publishSignatures.verify({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            request: payload,
          });
          return yield* publisher.publish({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            state: payload.state,
          });
        },
        mapRelayCommonApiErrors("not_authorized"),
        mapErrorTags({
          EnvironmentPublishPublicKeyMissing: (_error, traceId) =>
            new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "not_authorized",
              traceId,
            }),
          EnvironmentPublishSignatureExpired: (_error, traceId) =>
            new RelayAgentActivityPublishProofExpiredError({
              code: "agent_activity_publish_proof_expired",
              traceId,
            }),
          EnvironmentPublishSignatureInvalid: (_error, traceId) =>
            new RelayAgentActivityPublishProofInvalidError({
              code: "agent_activity_publish_proof_invalid",
              reason: "invalid_signature_or_payload",
              traceId,
            }),
          DpopProofReplayPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
          ApnsDeliveryJobInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobExpired: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobClaimInFlight: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryQueueSendError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
        }),
      ),
    );
  }),
);

class ClerkTokenVerificationFailed extends Data.TaggedError("ClerkTokenVerificationFailed")<{
  readonly cause: unknown;
}> {}

const isHttpUnauthorized = Schema.is(HttpApiError.Unauthorized);

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

function taggedErrorName(error: unknown): string {
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : error instanceof Error
      ? error.name
      : typeof error;
}

function annotateRelayRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure" ? logRelayApiFailure(endpoint, traceId)(exit.cause) : Effect.void,
    );
    yield* Effect.annotateLogsScoped({
      "relay.endpoint": endpoint,
      traceId,
    });

    yield* Effect.annotateCurrentSpan({
      "relay.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

function logRelayApiFailure(endpoint: string, traceId: string) {
  return (cause: unknown) =>
    Effect.logWarning("relay api request failed", {
      endpoint,
      traceId,
      errorTag: taggedErrorName(cause),
      cause,
    });
}

type RelayCommonPersistenceError =
  | Devices.DeviceRegistrationPersistenceError
  | Devices.DeviceUnregistrationPersistenceError
  | LiveActivities.LiveActivityRegistrationPersistenceError
  | EnvironmentLinks.EnvironmentLinkUserListPersistenceError
  | EnvironmentLinks.EnvironmentPublicKeyListPersistenceError
  | EnvironmentLinks.EnvironmentLinkListPersistenceError
  | EnvironmentLinks.EnvironmentLinkLookupPersistenceError
  | EnvironmentLinks.EnvironmentLinkRevokePersistenceError
  | EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError
  | EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError
  | LiveActivities.LiveActivityTargetListPersistenceError
  | AgentActivityRows.AgentActivityRowUpsertPersistenceError
  | AgentActivityRows.AgentActivityRowDeletePersistenceError
  | AgentActivityRows.AgentActivityRowListPersistenceError
  | LiveActivities.LiveActivityDeliveryMarkPersistenceError
  | DeliveryAttempts.DeliveryAttemptRecordPersistenceError;

type MapRelayCommonApiError<E> =
  | Exclude<E, HttpApiError.Unauthorized | RelayCommonPersistenceError>
  | (Extract<E, HttpApiError.Unauthorized> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, RelayCommonPersistenceError> extends never ? never : RelayInternalError);

function isRelayCommonPersistenceError(error: unknown): error is RelayCommonPersistenceError {
  return (
    error instanceof Devices.DeviceRegistrationPersistenceError ||
    error instanceof Devices.DeviceUnregistrationPersistenceError ||
    error instanceof LiveActivities.LiveActivityRegistrationPersistenceError ||
    error instanceof EnvironmentLinks.EnvironmentLinkUserListPersistenceError ||
    error instanceof EnvironmentLinks.EnvironmentPublicKeyListPersistenceError ||
    error instanceof EnvironmentLinks.EnvironmentLinkListPersistenceError ||
    error instanceof EnvironmentLinks.EnvironmentLinkLookupPersistenceError ||
    error instanceof EnvironmentLinks.EnvironmentLinkRevokePersistenceError ||
    error instanceof EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError ||
    error instanceof EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError ||
    error instanceof LiveActivities.LiveActivityTargetListPersistenceError ||
    error instanceof AgentActivityRows.AgentActivityRowUpsertPersistenceError ||
    error instanceof AgentActivityRows.AgentActivityRowDeletePersistenceError ||
    error instanceof AgentActivityRows.AgentActivityRowListPersistenceError ||
    error instanceof LiveActivities.LiveActivityDeliveryMarkPersistenceError ||
    error instanceof DeliveryAttempts.DeliveryAttemptRecordPersistenceError
  );
}

function relayInternalErrorResponse(reason: RelayInternalError["reason"]) {
  return currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayInternalError({ code: "internal_error", reason, traceId })),
    ),
  );
}

function mapRelayCommonApiErrors(authReason: RelayAuthInvalidReason) {
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MapRelayCommonApiError<E>, R> =>
    effect.pipe(
      Effect.catch(
        (error: E): Effect.Effect<never, MapRelayCommonApiError<E>> =>
          Effect.gen(function* () {
            const traceId = yield* currentTraceId;
            if (isHttpUnauthorized(error)) {
              return yield* Effect.fail(
                new RelayAuthInvalidError({
                  code: "auth_invalid",
                  reason: authReason,
                  traceId,
                }) as MapRelayCommonApiError<E>,
              );
            }
            if (isRelayCommonPersistenceError(error)) {
              return yield* Effect.fail(
                new RelayInternalError({
                  code: "internal_error",
                  reason: "persistence_failed",
                  traceId,
                }) as MapRelayCommonApiError<E>,
              );
            }

            return yield* Effect.fail(error as MapRelayCommonApiError<E>);
          }),
      ),
    );
}

type TaggedErrorTag<E> = Extract<E, { readonly _tag: string }>["_tag"];

type MapErrorTagCases<E> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
    traceId: string,
  ) => unknown;
};

type MappedTagError<Cases> = Cases[keyof Cases] extends (
  ...args: ReadonlyArray<never>
) => infer Error
  ? Error
  : never;

type CatchTagCases<E, Cases> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
  ) => Effect.Effect<never, MappedTagError<Cases>>;
} & (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never });

function mapErrorTags<
  E,
  Cases extends MapErrorTagCases<E> &
    (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never }),
>(cases: Cases) {
  const catchCases = Record.map(
    cases as Record.ReadonlyRecord<
      string,
      (error: never, traceId: string) => MappedTagError<Cases>
    >,
    (makeError) => (error: never) =>
      currentTraceId.pipe(Effect.flatMap((traceId) => Effect.fail(makeError(error, traceId)))),
  ) as CatchTagCases<E, Cases>;

  return <A, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>, R> =>
    Effect.catchTags(self, catchCases) as Effect.Effect<
      A,
      Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>,
      R
    >;
}

function resolveConnectClientKeyThumbprint(payload: RelayEnvironmentConnectRequest): string | null {
  const requestedThumbprint = payload.clientKeyThumbprint ?? payload.clientProofKeyThumbprint;
  if (!requestedThumbprint) {
    return null;
  }
  if (
    payload.clientKeyThumbprint &&
    payload.clientProofKeyThumbprint &&
    payload.clientKeyThumbprint !== payload.clientProofKeyThumbprint
  ) {
    return null;
  }
  return requestedThumbprint;
}

function safeAuthFailureReason(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : "unknown";
}

function clerkVerificationFailureReason(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return safeAuthFailureReason(reason);
    }
  }
  if (cause instanceof Error && cause.name) {
    return safeAuthFailureReason(cause.name);
  }
  return "unknown";
}

function verifyClerkBearerToken(settings: Settings.SettingsShape, token: string) {
  return Effect.tryPromise({
    try: () =>
      verifyToken(token, {
        secretKey: Redacted.value(settings.clerkSecretKey),
        audience: normalizeRelayIssuer(settings.relayIssuer),
      }),
    catch: (cause) => new ClerkTokenVerificationFailed({ cause }),
  });
}

function requireDpopPrincipalScope(scope: RelayDpopAccessTokenScope) {
  return Effect.gen(function* () {
    const principal = yield* RelayClientPrincipal;
    if (!principal.proofKeyThumbprint || !principal.dpopScopes?.includes(scope)) {
      return yield* new HttpApiError.Unauthorized({});
    }
    return principal.proofKeyThumbprint;
  });
}

function requireDpopThumbprint(
  expectedThumbprint: string,
  dpopProofs: DpopProofs.DpopProofReplayShape,
  options?: {
    readonly expectedAccessToken?: string;
  },
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const now = yield* DateTime.now;
    const url = HttpServerRequest.toURL(request);
    if (url._tag === "None") {
      return yield* new HttpApiError.Unauthorized({});
    }
    return yield* verifyAndConsumeDpopProof({
      proof: request.headers.dpop,
      method: request.method,
      url: url.value.href,
      now,
      expectedThumbprint,
      ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
      dpopProofs,
    });
  });
}

function requireDpopProof(
  dpopProofs: DpopProofs.DpopProofReplayShape,
  options?: {
    readonly expectedAccessToken?: string;
  },
) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const now = yield* DateTime.now;
    const url = HttpServerRequest.toURL(request);
    if (url._tag === "None") {
      return yield* new HttpApiError.Unauthorized({});
    }
    return yield* verifyAndConsumeDpopProof({
      proof: request.headers.dpop,
      method: request.method,
      url: url.value.href,
      now,
      ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
      dpopProofs,
    });
  });
}

function relayAuthInvalidError(reason: RelayAuthInvalidReason) {
  return Effect.gen(function* () {
    const traceId = yield* currentTraceId;
    yield* Effect.annotateCurrentSpan({
      "relay.trace_id": traceId,
      "relay.error.outbound_tag": "RelayAuthInvalidError",
      "relay.error.outbound_reason": reason,
    });
    return yield* new RelayAuthInvalidError({ code: "auth_invalid", reason, traceId });
  });
}
