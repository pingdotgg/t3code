import {
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponse,
  RelayEnvironmentMintResponseProofPayload,
  RelayCloudMintCredentialProofPayload,
  type RelayEnvironmentConnectResponse,
  type RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as RelayConfiguration from "../Config.ts";
import { isManagedEndpointHostname } from "../deploymentConfig.ts";

export const EnvironmentConnectNotAuthorizedReason = Schema.Literals([
  "client_proof_key_thumbprint_missing",
  "environment_link_not_found",
  "endpoint_provider_not_managed",
  "managed_endpoint_allocation_not_found",
  "managed_endpoint_base_domain_not_configured",
  "managed_endpoint_allocation_not_ready",
  "managed_endpoint_hostname_invalid",
  "managed_endpoint_mismatch",
]);
export type EnvironmentConnectNotAuthorizedReason =
  typeof EnvironmentConnectNotAuthorizedReason.Type;

function environmentConnectNotAuthorizedReasonMessage(
  reason: EnvironmentConnectNotAuthorizedReason,
): string {
  switch (reason) {
    case "client_proof_key_thumbprint_missing":
      return "the client proof key thumbprint is missing";
    case "environment_link_not_found":
      return "no active environment link was found";
    case "endpoint_provider_not_managed":
      return "the linked endpoint is not relay-managed";
    case "managed_endpoint_allocation_not_found":
      return "no managed endpoint allocation was found";
    case "managed_endpoint_base_domain_not_configured":
      return "the managed endpoint base domain is not configured";
    case "managed_endpoint_allocation_not_ready":
      return "the managed endpoint allocation is incomplete";
    case "managed_endpoint_hostname_invalid":
      return "the managed endpoint hostname is invalid";
    case "managed_endpoint_mismatch":
      return "the linked endpoint does not match its managed allocation";
  }
}

export class EnvironmentConnectNotAuthorized extends Schema.TaggedErrorClass<EnvironmentConnectNotAuthorized>()(
  "EnvironmentConnectNotAuthorized",
  {
    environmentId: Schema.String,
    operation: Schema.Literals(["connect", "status"]),
    reason: EnvironmentConnectNotAuthorizedReason,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' is not authorized for ${this.operation}: ${environmentConnectNotAuthorizedReasonMessage(this.reason)}`;
  }
}

export class EnvironmentMintRequestFailed extends Schema.TaggedErrorClass<EnvironmentMintRequestFailed>()(
  "EnvironmentMintRequestFailed",
  {
    environmentId: Schema.String,
    operation: Schema.Literals(["connect", "status"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' ${this.operation} request failed`;
  }
}

export class EnvironmentMintRequestTimedOut extends Schema.TaggedErrorClass<EnvironmentMintRequestTimedOut>()(
  "EnvironmentMintRequestTimedOut",
  {
    environmentId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' mint request timed out after ${this.timeoutMs}ms`;
  }
}

export class EnvironmentMintResponseInvalid extends Schema.TaggedErrorClass<EnvironmentMintResponseInvalid>()(
  "EnvironmentMintResponseInvalid",
  {
    environmentId: Schema.String,
    operation: Schema.Literals(["connect", "status"]),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' returned an invalid ${this.operation} response`;
  }
}

export type EnvironmentConnectorError =
  | EnvironmentConnectNotAuthorized
  | EnvironmentMintRequestFailed
  | EnvironmentMintRequestTimedOut
  | EnvironmentMintResponseInvalid
  | EnvironmentLinks.EnvironmentLinkLookupPersistenceError
  | ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError;

export const ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS = 10_000;
const ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS = 60 * 1_000;

export interface EnvironmentConnectorShape {
  readonly connect: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly clientProofKeyThumbprint: string;
    readonly deviceId?: string;
  }) => Effect.Effect<RelayEnvironmentConnectResponse, EnvironmentConnectorError>;
  readonly status: (input: {
    readonly userId: string;
    readonly environmentId: string;
  }) => Effect.Effect<RelayEnvironmentStatusResponse, EnvironmentConnectorError>;
}

export class EnvironmentConnector extends Context.Service<
  EnvironmentConnector,
  EnvironmentConnectorShape
>()("t3code-relay/environments/EnvironmentConnector") {}

const decodeMintResponseProof = Schema.decodeUnknownEffect(
  RelayEnvironmentMintResponseProofPayload,
);
const decodeHealthResponseProof = Schema.decodeUnknownEffect(
  RelayEnvironmentHealthResponseProofPayload,
);
const isEnvironmentHealthError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
  ]),
);

function environmentHealthRequestFailureMessage(cause: unknown): string {
  return isEnvironmentHealthError(cause)
    ? `Managed endpoint health request failed: ${cause.message}`
    : "Managed endpoint health request failed.";
}

const withoutRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

const verifyWithEnvironmentKeys = Effect.fnUntraced(function* <A, E>(input: {
  readonly token: string;
  readonly typ: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly decodePayload: (input: unknown) => Effect.Effect<A, E>;
}) {
  const { decodePayload, ...rest } = input;
  for (const publicKey of input.environmentPublicKeys) {
    const proof = yield* verifyRelayJwt({ ...rest, publicKey }).pipe(
      Effect.flatMap(decodePayload),
      Effect.option,
    );
    if (Option.isSome(proof)) {
      return proof.value;
    }
    // A linked environment can have rotated keys; try the remaining active keys.
  }
  return null;
});

function verifyEnvironmentResponse(input: {
  readonly response: RelayEnvironmentMintResponse;
  readonly environmentId: string;
  readonly requestNonce: string;
  readonly clientProofKeyThumbprint: string;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly relayIssuer: string;
  readonly nowEpochSeconds: number;
}) {
  return verifyWithEnvironmentKeys({
    token: input.response.proof,
    typ: RELAY_MINT_RESPONSE_TYP,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(input.relayIssuer),
    nowEpochSeconds: input.nowEpochSeconds,
    environmentPublicKeys: input.environmentPublicKeys,
    decodePayload: decodeMintResponseProof,
  }).pipe(
    Effect.map(
      (proof) =>
        proof !== null &&
        proof.environmentId === input.environmentId &&
        proof.requestNonce === input.requestNonce &&
        proof.clientProofKeyThumbprint === input.clientProofKeyThumbprint &&
        proof.credential === input.response.credential &&
        Option.match(DateTime.make(input.response.expiresAt), {
          onNone: () => false,
          onSome: (expiresAt) => Math.floor(expiresAt.epochMilliseconds / 1_000) === proof.exp,
        }),
    ),
  );
}

function verifyEnvironmentHealthResponse(input: {
  readonly response: RelayEnvironmentHealthResponse;
  readonly environmentId: string;
  readonly requestNonce: string;
  readonly requestIssuedAt: DateTime.DateTime;
  readonly environmentPublicKeys: ReadonlyArray<string>;
  readonly relayIssuer: string;
  readonly now: DateTime.DateTime;
}) {
  return verifyWithEnvironmentKeys({
    token: input.response.proof,
    typ: RELAY_HEALTH_RESPONSE_TYP,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(input.relayIssuer),
    nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
    environmentPublicKeys: input.environmentPublicKeys,
    decodePayload: decodeHealthResponseProof,
  }).pipe(
    Effect.map((proof) => {
      if (
        proof === null ||
        input.response.environmentId !== input.environmentId ||
        proof.environmentId !== input.environmentId ||
        proof.requestNonce !== input.requestNonce ||
        proof.status !== input.response.status ||
        proof.checkedAt !== input.response.checkedAt ||
        stableStringify(proof.descriptor) !== stableStringify(input.response.descriptor)
      ) {
        return false;
      }
      const checkedAt = DateTime.make(input.response.checkedAt);
      if (Option.isNone(checkedAt)) {
        return false;
      }
      return (
        checkedAt.value.epochMilliseconds >=
          input.requestIssuedAt.epochMilliseconds - ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS &&
        checkedAt.value.epochMilliseconds <=
          input.now.epochMilliseconds + ENVIRONMENT_HEALTH_CLOCK_SKEW_MILLIS
      );
    }),
  );
}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
  const settings = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const relayIssuer = normalizeRelayIssuer(settings.relayIssuer);
  const makeEnvironmentClient = (httpBaseUrl: string) =>
    makeEnvironmentHttpApiClient(httpBaseUrl).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  const resolveManagedEndpoint = Effect.fn("relay.environment_connector.resolve_managed_endpoint")(
    function* (input: {
      readonly userId: string;
      readonly operation: "connect" | "status";
      readonly link: EnvironmentLinks.RelayLinkedEnvironmentRecord;
    }) {
      if (input.link.endpoint.providerKind !== "cloudflare_tunnel") {
        yield* Effect.annotateCurrentSpan({
          "relay.authorization.endpoint_provider_kind": input.link.endpoint.providerKind,
        });
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "endpoint_provider_not_managed",
        });
      }
      const allocation = yield* allocations.get({
        userId: input.userId,
        environmentId: input.link.environmentId,
      });
      if (!allocation) {
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "managed_endpoint_allocation_not_found",
        });
      }
      const allocationAttributes = {
        "relay.authorization.allocation_hostname": allocation.hostname,
        "relay.authorization.allocation_has_ready_at": allocation.readyAt !== null,
        "relay.authorization.allocation_has_tunnel_id": allocation.tunnelId !== null,
        "relay.authorization.allocation_has_dns_record_id": allocation.dnsRecordId !== null,
      } as const;
      if (!settings.managedEndpointBaseDomain) {
        yield* Effect.annotateCurrentSpan(allocationAttributes);
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "managed_endpoint_base_domain_not_configured",
        });
      }
      if (
        allocation.readyAt === null ||
        allocation.tunnelId === null ||
        allocation.dnsRecordId === null
      ) {
        yield* Effect.annotateCurrentSpan(allocationAttributes);
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "managed_endpoint_allocation_not_ready",
        });
      }
      if (!isManagedEndpointHostname(allocation.hostname, settings.managedEndpointBaseDomain)) {
        yield* Effect.annotateCurrentSpan({
          ...allocationAttributes,
          "relay.authorization.managed_endpoint_base_domain": settings.managedEndpointBaseDomain,
        });
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "managed_endpoint_hostname_invalid",
        });
      }
      const endpoint = ManagedEndpointAllocations.resolveReadyManagedEndpoint({
        allocation,
        baseDomain: settings.managedEndpointBaseDomain,
      });
      if (
        endpoint === null ||
        endpoint.httpBaseUrl !== input.link.endpoint.httpBaseUrl ||
        endpoint.wsBaseUrl !== input.link.endpoint.wsBaseUrl
      ) {
        yield* Effect.annotateCurrentSpan({
          ...allocationAttributes,
          "relay.authorization.linked_http_base_url": input.link.endpoint.httpBaseUrl,
          "relay.authorization.linked_ws_base_url": input.link.endpoint.wsBaseUrl,
          ...(endpoint
            ? {
                "relay.authorization.resolved_http_base_url": endpoint.httpBaseUrl,
                "relay.authorization.resolved_ws_base_url": endpoint.wsBaseUrl,
              }
            : {}),
        });
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.link.environmentId,
          operation: input.operation,
          reason: "managed_endpoint_mismatch",
        });
      }
      return endpoint;
    },
  );

  return EnvironmentConnector.of({
    status: Effect.fn("relay.environment_connector.status")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.operation": "status",
      });
      const link = yield* links.getForUser(input);
      if (!link) {
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.environmentId,
          operation: "status",
          reason: "environment_link_not_found",
        });
      }
      const endpoint = yield* resolveManagedEndpoint({
        userId: input.userId,
        operation: "status",
        link,
      });
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 2 });
      const nonce = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentMintRequestFailed({
              environmentId: input.environmentId,
              operation: "status",
              cause,
            }),
        ),
      );
      const payload = {
        iss: relayIssuer,
        aud: `t3-env:${link.environmentId}`,
        sub: input.userId,
        jti: yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentMintRequestFailed({
                environmentId: input.environmentId,
                operation: "status",
                cause,
              }),
          ),
        ),
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        environmentId: link.environmentId,
        nonce,
        scope: ["environment:status"],
      } satisfies RelayCloudEnvironmentHealthProofPayload;
      const proof = yield* signRelayJwt({
        privateKey: Redacted.value(settings.cloudMintPrivateKey),
        typ: RELAY_HEALTH_REQUEST_TYP,
        payload,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentMintRequestFailed({
              environmentId: input.environmentId,
              operation: "status",
              cause,
            }),
        ),
      );
      const checkedAt = DateTime.formatIso(now);
      const environmentClient = yield* makeEnvironmentClient(endpoint.httpBaseUrl);
      const responseOption = yield* environmentClient.cloud.health({ payload: { proof } }).pipe(
        withoutRedirects,
        Effect.match({
          onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
          onSuccess: (response) => ({ _tag: "Success" as const, response }),
        }),
        Effect.timeoutOption(Duration.millis(ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS)),
      );
      if (Option.isNone(responseOption)) {
        return {
          environmentId: link.environmentId,
          endpoint,
          status: "offline" as const,
          checkedAt,
          error: "Managed endpoint health request timed out.",
        };
      }
      if (responseOption.value._tag === "Failure") {
        return {
          environmentId: link.environmentId,
          endpoint,
          status: "offline" as const,
          checkedAt,
          error: environmentHealthRequestFailureMessage(responseOption.value.cause),
        };
      }
      const decoded = responseOption.value.response;
      const verified = yield* verifyEnvironmentHealthResponse({
        response: decoded,
        environmentId: input.environmentId,
        requestNonce: nonce,
        requestIssuedAt: now,
        environmentPublicKeys: [link.environmentPublicKey],
        relayIssuer,
        now: yield* DateTime.now,
      });
      if (!verified) {
        return yield* new EnvironmentMintResponseInvalid({
          environmentId: input.environmentId,
          operation: "status",
        });
      }
      return {
        environmentId: link.environmentId,
        endpoint,
        status: "online" as const,
        checkedAt: decoded.checkedAt,
        descriptor: decoded.descriptor,
      };
    }),
    connect: Effect.fn("relay.environment_connector.connect")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.operation": "connect",
        "relay.connect.has_device_id": input.deviceId !== undefined,
        ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
      });
      if (input.clientProofKeyThumbprint.trim().length === 0) {
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.environmentId,
          operation: "connect",
          reason: "client_proof_key_thumbprint_missing",
        });
      }
      const link = yield* links.getForUser(input);
      if (!link) {
        return yield* new EnvironmentConnectNotAuthorized({
          environmentId: input.environmentId,
          operation: "connect",
          reason: "environment_link_not_found",
        });
      }
      const endpoint = yield* resolveManagedEndpoint({
        userId: input.userId,
        operation: "connect",
        link,
      });
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 2 });
      const nonce = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentMintRequestFailed({
              environmentId: input.environmentId,
              operation: "connect",
              cause,
            }),
        ),
      );
      const payload = {
        iss: relayIssuer,
        aud: `t3-env:${link.environmentId}`,
        sub: input.userId,
        jti: yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentMintRequestFailed({
                environmentId: input.environmentId,
                operation: "connect",
                cause,
              }),
          ),
        ),
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        environmentId: link.environmentId,
        clientProofKeyThumbprint: input.clientProofKeyThumbprint,
        cnf: { jkt: input.clientProofKeyThumbprint },
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        nonce,
        scope: ["environment:connect"],
      } satisfies RelayCloudMintCredentialProofPayload;
      const proof = yield* signRelayJwt({
        privateKey: Redacted.value(settings.cloudMintPrivateKey),
        typ: RELAY_MINT_REQUEST_TYP,
        payload,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentMintRequestFailed({
              environmentId: input.environmentId,
              operation: "connect",
              cause,
            }),
        ),
      );
      const environmentClient = yield* makeEnvironmentClient(endpoint.httpBaseUrl);
      const decoded = yield* environmentClient.cloud.t3MintCredential({ payload: { proof } }).pipe(
        withoutRedirects,
        Effect.mapError(
          (cause) =>
            new EnvironmentMintRequestFailed({
              environmentId: input.environmentId,
              operation: "connect",
              cause,
            }),
        ),
        Effect.timeoutOption(Duration.millis(ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS)),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new EnvironmentMintRequestTimedOut({
                  environmentId: input.environmentId,
                  timeoutMs: ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      const verified = yield* verifyEnvironmentResponse({
        response: decoded,
        environmentId: input.environmentId,
        requestNonce: nonce,
        clientProofKeyThumbprint: input.clientProofKeyThumbprint,
        environmentPublicKeys: [link.environmentPublicKey],
        relayIssuer,
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      });
      if (!verified) {
        return yield* new EnvironmentMintResponseInvalid({
          environmentId: input.environmentId,
          operation: "connect",
        });
      }
      return {
        environmentId: link.environmentId,
        endpoint,
        credential: decoded.credential,
        expiresAt: decoded.expiresAt,
      };
    }),
  });
});

export const layer = Layer.effect(EnvironmentConnector, make);
