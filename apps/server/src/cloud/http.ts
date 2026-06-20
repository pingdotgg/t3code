import * as NodeCrypto from "node:crypto";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudRelayConfigResult,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  type EnvironmentHttpInternalOperation,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpRelayOperation,
  EnvironmentHttpRelayPhase,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentMintResponse as RelayEnvironmentMintResponseShape,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import { isSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  encodeEndpointRuntimeConfigJson,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";
import { setCliDesiredCloudLink } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

export class CloudRelayConfigurationError extends Schema.TaggedErrorClass<CloudRelayConfigurationError>()(
  "CloudRelayConfigurationError",
  {
    configKey: Schema.Literal("T3CODE_RELAY_URL"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.configKey} must be configured as a secure absolute HTTPS origin.`;
  }
}

export class CloudRelayRequestError extends Schema.TaggedErrorClass<CloudRelayRequestError>()(
  "CloudRelayRequestError",
  {
    operation: EnvironmentHttpRelayOperation,
    phase: EnvironmentHttpRelayPhase,
    method: Schema.Literal("POST"),
    requestUrlInputLength: Schema.Number,
    requestUrlProtocol: Schema.optionalKey(Schema.String),
    requestUrlHostname: Schema.optionalKey(Schema.String),
    responseStatus: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  static fromClientFailure(input: {
    readonly operation: CloudRelayRequestError["operation"];
    readonly url: string;
    readonly cause: HttpBody.HttpBodyError | HttpClientError.HttpClientError | Schema.SchemaError;
    readonly responseStatus?: number;
  }): CloudRelayRequestError {
    const diagnostics = getUrlDiagnostics(input.url);
    const context = {
      operation: input.operation,
      method: "POST" as const,
      requestUrlInputLength: diagnostics.inputLength,
      ...(diagnostics.protocol === undefined ? {} : { requestUrlProtocol: diagnostics.protocol }),
      ...(diagnostics.hostname === undefined ? {} : { requestUrlHostname: diagnostics.hostname }),
    };
    if (input.cause._tag === "SchemaError") {
      return new CloudRelayRequestError({
        ...context,
        phase: "decode-response",
        ...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
        cause: input.cause,
      });
    }

    if (!HttpClientError.isHttpClientError(input.cause)) {
      return new CloudRelayRequestError({
        ...context,
        phase: "encode-request",
        cause: input.cause,
      });
    }

    const phase: CloudRelayRequestError["phase"] = (() => {
      switch (input.cause.reason._tag) {
        case "EncodeError":
          return "encode-request";
        case "TransportError":
        case "InvalidUrlError":
          return "send-request";
        case "StatusCodeError":
          return "check-response-status";
        case "DecodeError":
        case "EmptyBodyError":
          return "decode-response";
      }
    })();

    return new CloudRelayRequestError({
      ...context,
      phase,
      ...(input.cause.response === undefined
        ? input.responseStatus === undefined
          ? {}
          : { responseStatus: input.responseStatus }
        : { responseStatus: input.cause.response.status }),
      cause: input.cause,
    });
  }

  override get message(): string {
    const responseStatus =
      this.responseStatus === undefined ? "" : ` with response status ${this.responseStatus}`;
    return `T3 Connect relay ${this.operation} failed during ${this.phase}${responseStatus}.`;
  }
}

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

function errorDiagnosticTag(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string"
  ) {
    return cause._tag;
  }
  if (cause instanceof Error) return cause.name;
  return typeof cause;
}

type EnvironmentCloudInternalErrorContext =
  | Exclude<EnvironmentHttpInternalOperation, "relay_request">
  | {
      readonly operation: "relay_request";
      readonly relayOperation: CloudRelayRequestError["operation"];
      readonly relayPhase: CloudRelayRequestError["phase"];
      readonly responseStatus?: number;
    };

const failEnvironmentCloudInternalError =
  (context: EnvironmentCloudInternalErrorContext) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> => {
    const error =
      typeof context === "string"
        ? new EnvironmentHttpInternalServerError({ operation: context, cause })
        : new EnvironmentHttpInternalServerError({ ...context, cause });
    const logContext =
      typeof context === "string"
        ? { operation: context, causeTag: errorDiagnosticTag(cause) }
        : { ...context, causeTag: errorDiagnosticTag(cause) };
    return Effect.logError(error.message, logContext).pipe(
      Effect.flatMap(() => Effect.fail(error)),
    );
  };

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    (cause) =>
      new CloudRelayConfigurationError({
        configKey: "T3CODE_RELAY_URL",
        cause,
      }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.all(
    input.names.map((name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchTags({
          SecretStorePersistError: (error) =>
            ServerSecretStore.isSecretAlreadyExistsError(error)
              ? Effect.succeed(false)
              : Effect.fail(error),
        }),
      ),
    ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: (cause) =>
      new EnvironmentHttpBadRequestError({
        reason: "invalid_cloud_mint_public_key",
        cause,
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              reason: "invalid_cloud_mint_public_key",
            }),
          ),
    ),
  );
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        reason: "invalid_relay_url",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        reason: "invalid_relay_issuer",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        reason: "missing_relay_environment_credential",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        reason: "missing_cloud_user_id",
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly cloudUserId: string;
}) {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({
          cause,
        }),
    ),
    Effect.flatMap((existing) => {
      if (Option.isNone(existing)) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing.value);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpConflictError({
              reason: "linked_to_different_cloud_account",
            }),
          );
    }),
  );
}

function readInstalledCloudUserId(secrets: ServerSecretStore.ServerSecretStore["Service"]) {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({
          cause,
        }),
    ),
    Effect.flatMap((bytes) =>
      Option.isSome(bytes)
        ? Effect.succeed(bytesToString(bytes.value))
        : Effect.fail(new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({})),
    ),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

function providerKindMatchesRequestedLinkScopes(request: RelayLinkProofRequest): boolean {
  return request.endpoint.providerKind === "cloudflare_tunnel";
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

interface CloudHttpDependencies {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"];
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly cliTokenManager: CliTokenManager.CloudCliTokenManager["Service"];
  readonly httpClient: HttpClient.HttpClient;
}

const cloudHttpDependencies = Effect.gen(function* () {
  return {
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environment: yield* ServerEnvironment.ServerEnvironment,
    endpointRuntime: yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime,
    environmentAuth: yield* EnvironmentAuth.EnvironmentAuth,
    cliTokenManager: yield* CliTokenManager.CloudCliTokenManager,
    httpClient: yield* HttpClient.HttpClient,
  } satisfies CloudHttpDependencies;
});

const makeCloudLinkProof = Effect.fn("environment.cloud.makeLinkProof")(function* (
  dependencies: CloudHttpDependencies,
  request: RelayLinkProofRequest,
  requestUrl: string,
) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
  if (
    !providerKindMatchesRequestedLinkScopes(request) ||
    !isAllowedEndpointOrigin({
      origin: request.origin,
      requestUrl,
    })
  ) {
    return yield* new EnvironmentHttpBadRequestError({
      reason: "invalid_managed_endpoint_origin",
    });
  }
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const descriptor = yield* dependencies.environment.getDescriptor;
  const payload = {
    iss: `t3-env:${descriptor.environmentId}`,
    aud: normalizeRelayIssuer(request.relayIssuer),
    sub: descriptor.environmentId,
    jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    iat: nowSeconds,
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge: request.challenge,
    descriptor,
    environmentId: descriptor.environmentId,
    environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
    endpoint: request.endpoint,
    origin: request.origin,
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  } satisfies RelayEnvironmentLinkProofPayload;
  return yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_LINK_PROOF_TYP,
    payload,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({
          cause,
        }),
    ),
  );
});

const cloudLinkProofHandler = Effect.fn("environment.cloud.linkProof")(
  function* (dependencies: CloudHttpDependencies, request: RelayLinkProofRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = requestAbsoluteUrl(httpRequest);
    if (requestUrl === null || hasForwardedAuthorityHeaders(httpRequest)) {
      return yield* new EnvironmentHttpBadRequestError({
        reason: "invalid_managed_endpoint_origin",
      });
    }
    const proof = yield* makeCloudLinkProof(dependencies, request, requestUrl);
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchTags({
    ServerAuthCloudLinkJwtSigningError: (error) =>
      failEnvironmentCloudInternalError("sign_cloud_link_jwt")(error),
    SecretStoreReadError: failEnvironmentCloudInternalError("generate_link_proof"),
    SecretStoreDecodeError: failEnvironmentCloudInternalError("generate_link_proof"),
    SecretStoreEncodeError: failEnvironmentCloudInternalError("generate_link_proof"),
    SecretStorePersistError: failEnvironmentCloudInternalError("generate_link_proof"),
    SecretStoreConcurrentReadError: failEnvironmentCloudInternalError("generate_link_proof"),
    PlatformError: failEnvironmentCloudInternalError("generate_link_proof"),
  }),
);

const applyCloudRelayConfig = Effect.fn("environment.cloud.applyRelayConfig")(function* (
  dependencies: CloudHttpDependencies,
  payload: RelayEnvironmentConfigRequest,
) {
  yield* validateRelayConfigPayload(payload);
  yield* validateLinkedCloudUser({
    secrets: dependencies.secrets,
    cloudUserId: payload.cloudUserId,
  });
  yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
  const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(
    payload.endpointRuntime,
  );
  const ok =
    endpointRuntimeStatus.status === "disabled" || endpointRuntimeStatus.status === "running";
  if (!ok) {
    return yield* new EnvironmentCloudEndpointUnavailableError({
      endpointRuntimeStatus,
    });
  }

  yield* dependencies.secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
  yield* dependencies.secrets.set(
    RELAY_ISSUER_SECRET,
    stringToBytes(payload.relayIssuer ?? payload.relayUrl),
  );
  yield* dependencies.secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
  yield* dependencies.secrets.set(
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    stringToBytes(payload.environmentCredential),
  );
  yield* dependencies.secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
  if (payload.endpointRuntime) {
    const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
    yield* dependencies.secrets.set(
      CLOUD_ENDPOINT_RUNTIME_CONFIG,
      stringToBytes(endpointRuntimeJson),
    );
  } else {
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
  }
  return { ok, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
});

const cloudRelayConfigHandler = Effect.fn("environment.cloud.relayConfig")(
  function* (dependencies: CloudHttpDependencies, payload: RelayEnvironmentConfigRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    return yield* applyCloudRelayConfig(dependencies, payload);
  },
  Effect.catchTags({
    ServerAuthLinkedCloudAccountVerificationError: (error) =>
      failEnvironmentCloudInternalError("verify_linked_cloud_account")(error),
    SecretStoreTemporaryPathGenerationError: failEnvironmentCloudInternalError(
      "persist_relay_configuration",
    ),
    SecretStorePersistError: failEnvironmentCloudInternalError("persist_relay_configuration"),
    SecretStoreRemoveError: failEnvironmentCloudInternalError("persist_relay_configuration"),
    SchemaError: failEnvironmentCloudInternalError("persist_relay_configuration"),
  }),
);

const relayClientRequest = <A>(
  dependencies: CloudHttpDependencies,
  input: {
    readonly operation: CloudRelayRequestError["operation"];
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
  },
) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.bodyJson(input.payload),
    Effect.mapError((cause) =>
      CloudRelayRequestError.fromClientFailure({
        operation: input.operation,
        url: input.url,
        cause,
      }),
    ),
    Effect.flatMap((request) =>
      dependencies.httpClient.execute(request).pipe(
        Effect.mapError((cause) =>
          CloudRelayRequestError.fromClientFailure({
            operation: input.operation,
            url: input.url,
            cause,
          }),
        ),
      ),
    ),
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.mapError((cause) =>
          CloudRelayRequestError.fromClientFailure({
            operation: input.operation,
            url: input.url,
            cause,
          }),
        ),
      ),
    ),
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(input.schema)(response).pipe(
        Effect.mapError((cause) =>
          CloudRelayRequestError.fromClientFailure({
            operation: input.operation,
            url: input.url,
            responseStatus: response.status,
            cause,
          }),
        ),
      ),
    ),
    withRelayClientTracing,
  );

const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
  function* (dependencies: CloudHttpDependencies, localOrigin: string) {
    const localUrl = yield* Effect.try({
      try: () => new URL(localOrigin),
      catch: (cause) =>
        new EnvironmentHttpBadRequestError({
          reason: "invalid_local_environment_origin",
          cause,
        }),
    });
    if (localUrl.origin !== localOrigin) {
      return yield* new EnvironmentHttpBadRequestError({
        reason: "invalid_local_environment_origin",
      });
    }
    const localWsOrigin = localOrigin.replace(/^http/u, "ws");
    const token = yield* dependencies.cliTokenManager.getExisting.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                reason: "cloud_cli_authorization_required",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const relayUrl = yield* requireRelayUrl;
    const challenge = yield* relayClientRequest(dependencies, {
      operation: "create-link-challenge",
      url: `${relayUrl}/v1/client/environment-link-challenges`,
      token: token.accessToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
      },
      schema: RelayEnvironmentLinkChallengeResponse,
    });
    const proof = yield* makeCloudLinkProof(
      dependencies,
      {
        challenge: challenge.challenge,
        relayIssuer: relayUrl,
        endpoint: {
          httpBaseUrl: localOrigin,
          wsBaseUrl: localWsOrigin,
          providerKind: "cloudflare_tunnel",
        },
        origin: {
          localHttpHost: localUrl.hostname,
          localHttpPort: endpointRequestPort(localUrl),
        },
      },
      localOrigin,
    );
    const link = yield* relayClientRequest(dependencies, {
      operation: "create-environment-link",
      url: `${relayUrl}/v1/client/environment-links`,
      token: token.accessToken,
      payload: {
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
      },
      schema: RelayEnvironmentLinkResponse,
    });
    yield* setCliDesiredCloudLink(true);
    return yield* applyCloudRelayConfig(dependencies, {
      relayUrl,
      relayIssuer: link.relayIssuer,
      cloudUserId: link.cloudUserId,
      environmentCredential: link.environmentCredential,
      cloudMintPublicKey: link.cloudMintPublicKey,
      endpointRuntime: link.endpointRuntime,
    });
  },
  Effect.catchTags({
    ServerAuthLinkedCloudAccountVerificationError: (error) =>
      failEnvironmentCloudInternalError("verify_linked_cloud_account")(error),
    ServerAuthCloudLinkJwtSigningError: (error) =>
      failEnvironmentCloudInternalError("sign_cloud_link_jwt")(error),
    SecretStoreReadError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SecretStoreTemporaryPathGenerationError: failEnvironmentCloudInternalError(
      "persist_desired_link_state",
    ),
    SecretStorePersistError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SecretStoreRemoveError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SecretStoreDecodeError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SecretStoreEncodeError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SecretStoreConcurrentReadError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    SchemaError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    PlatformError: failEnvironmentCloudInternalError("persist_desired_link_state"),
    CloudRelayConfigurationError: (error) =>
      failEnvironmentCloudInternalError("read_relay_url_configuration")(error),
    CloudRelayRequestError: (error) =>
      failEnvironmentCloudInternalError({
        operation: "relay_request",
        relayOperation: error.operation,
        relayPhase: error.phase,
        ...(error.responseStatus === undefined ? {} : { responseStatus: error.responseStatus }),
      })(error),
    CloudCliCredentialRefreshError: (error) =>
      failEnvironmentCloudInternalError("refresh_cloud_cli_credential")(error),
  }),
);

export const reconcileDesiredCloudLink = Effect.fn("environment.cloud.reconcileDesiredLink")(
  function* (localOrigin: string) {
    return yield* reconcileDesiredCloudLinkWith(yield* cloudHttpDependencies, localOrigin);
  },
);

const readCloudLinkState = Effect.fn("environment.cloud.readLinkState")(function* (
  dependencies: CloudHttpDependencies,
) {
  const [cloudUserId, relayUrl, relayIssuer, publishAgentActivity] = yield* Effect.all(
    [
      dependencies.secrets.get(CLOUD_LINKED_USER_ID),
      dependencies.secrets.get(RELAY_URL_SECRET),
      dependencies.secrets.get(RELAY_ISSUER_SECRET),
      dependencies.secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
    ],
    { concurrency: 4 },
  );
  return {
    linked: Option.isSome(cloudUserId),
    cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
    relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
    relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
    publishAgentActivity: Option.isSome(publishAgentActivity)
      ? bytesToString(publishAgentActivity.value) === "true"
      : false,
  } satisfies EnvironmentCloudLinkStateResult;
});

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchTags({
    SecretStoreReadError: failEnvironmentCloudInternalError("read_relay_configuration"),
  }),
);

const cloudUnlinkHandler = Effect.fn("environment.cloud.unlink")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(null);
    yield* Effect.all(
      [
        dependencies.secrets.remove(CLOUD_LINKED_USER_ID),
        dependencies.secrets.remove(RELAY_URL_SECRET),
        dependencies.secrets.remove(RELAY_ISSUER_SECRET),
        dependencies.secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        dependencies.secrets.remove(CLOUD_MINT_PUBLIC_KEY),
        dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        dependencies.secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
      ],
      { concurrency: 7 },
    );
    yield* setCliDesiredCloudLink(false);
    return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchTags({
    SecretStoreTemporaryPathGenerationError: failEnvironmentCloudInternalError(
      "remove_relay_configuration",
    ),
    SecretStorePersistError: failEnvironmentCloudInternalError("remove_relay_configuration"),
    SecretStoreRemoveError: failEnvironmentCloudInternalError("remove_relay_configuration"),
  }),
);

const cloudPreferencesHandler = Effect.fn("environment.cloud.preferences")(
  function* (
    dependencies: CloudHttpDependencies,
    payload: { readonly publishAgentActivity: boolean },
  ) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    yield* dependencies.secrets.set(
      PUBLISH_AGENT_ACTIVITY_SECRET,
      stringToBytes(String(payload.publishAgentActivity)),
    );
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchTags({
    SecretStoreReadError: failEnvironmentCloudInternalError("persist_cloud_preferences"),
    SecretStoreTemporaryPathGenerationError: failEnvironmentCloudInternalError(
      "persist_cloud_preferences",
    ),
    SecretStorePersistError: failEnvironmentCloudInternalError("persist_cloud_preferences"),
  }),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_HEALTH_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        reason: "invalid_cloud_health_request",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        reason: "cloud_health_request_replayed",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const descriptor = yield* dependencies.environment.getDescriptor;
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      requestNonce: proof.nonce,
      status: "online",
      descriptor,
      checkedAt: DateTime.formatIso(now),
    } satisfies RelayEnvironmentHealthResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_HEALTH_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      environmentId,
      status: "online",
      descriptor,
      checkedAt: responsePayload.checkedAt,
      proof: responseProof,
    } satisfies RelayEnvironmentHealthResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchTags({
    ServerAuthLinkedCloudAccountReadError: (error) =>
      failEnvironmentCloudInternalError("read_linked_cloud_account")(error),
    ServerAuthLinkedCloudAccountMissingError: (error) =>
      failEnvironmentCloudInternalError("require_linked_cloud_account")(error),
    ServerAuthCloudMintPublicKeyMissingError: (error) =>
      failEnvironmentCloudInternalError("read_cloud_mint_public_key")(error),
    ServerAuthCloudRelayIssuerMissingError: (error) =>
      failEnvironmentCloudInternalError("read_cloud_relay_issuer")(error),
    ServerAuthCloudHealthJwtSigningError: (error) =>
      failEnvironmentCloudInternalError("sign_cloud_health_jwt")(error),
    SecretStoreReadError: failEnvironmentCloudInternalError("answer_cloud_health_request"),
    SecretStorePersistError: failEnvironmentCloudInternalError("answer_cloud_health_request"),
    SecretStoreDecodeError: failEnvironmentCloudInternalError("answer_cloud_health_request"),
    SecretStoreEncodeError: failEnvironmentCloudInternalError("answer_cloud_health_request"),
    SecretStoreConcurrentReadError: failEnvironmentCloudInternalError(
      "answer_cloud_health_request",
    ),
    PlatformError: failEnvironmentCloudInternalError("answer_cloud_health_request"),
  }),
);

const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_MINT_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        reason: "invalid_cloud_mint_request",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        reason: "cloud_mint_request_replayed",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const issued = yield* dependencies.environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "cloud-connect",
      ttl: Duration.minutes(2),
      label: "T3 Connect connect",
      proofKeyThumbprint: proof.clientProofKeyThumbprint,
    });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
      environmentId,
      clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
      requestNonce: proof.nonce,
      credential: issued.credential,
    } satisfies RelayEnvironmentMintResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MINT_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      credential: issued.credential,
      expiresAt: DateTime.formatIso(issued.expiresAt),
      proof: responseProof,
    } satisfies RelayEnvironmentMintResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchTags({
    ServerAuthLinkedCloudAccountReadError: (error) =>
      failEnvironmentCloudInternalError("read_linked_cloud_account")(error),
    ServerAuthLinkedCloudAccountMissingError: (error) =>
      failEnvironmentCloudInternalError("require_linked_cloud_account")(error),
    ServerAuthCloudMintPublicKeyMissingError: (error) =>
      failEnvironmentCloudInternalError("read_cloud_mint_public_key")(error),
    ServerAuthCloudRelayIssuerMissingError: (error) =>
      failEnvironmentCloudInternalError("read_cloud_relay_issuer")(error),
    ServerAuthPairingLinkCreationError: (error) =>
      failEnvironmentCloudInternalError("create_cloud_pairing_link")(error),
    ServerAuthCloudMintJwtSigningError: (error) =>
      failEnvironmentCloudInternalError("sign_cloud_mint_jwt")(error),
    SecretStoreReadError: failEnvironmentCloudInternalError("issue_cloud_connection_credential"),
    SecretStorePersistError: failEnvironmentCloudInternalError("issue_cloud_connection_credential"),
    SecretStoreDecodeError: failEnvironmentCloudInternalError("issue_cloud_connection_credential"),
    SecretStoreEncodeError: failEnvironmentCloudInternalError("issue_cloud_connection_credential"),
    SecretStoreConcurrentReadError: failEnvironmentCloudInternalError(
      "issue_cloud_connection_credential",
    ),
    PlatformError: failEnvironmentCloudInternalError("issue_cloud_connection_credential"),
  }),
);

export const connectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const dependencies = yield* cloudHttpDependencies;
    return handlers
      .handle("linkProof", ({ payload }) => cloudLinkProofHandler(dependencies, payload))
      .handle("relayConfig", ({ payload }) => cloudRelayConfigHandler(dependencies, payload))
      .handle("linkState", () => cloudLinkStateHandler(dependencies))
      .handle("unlink", () => cloudUnlinkHandler(dependencies))
      .handle("preferences", ({ payload }) => cloudPreferencesHandler(dependencies, payload))
      .handle("health", ({ payload }) => cloudEnvironmentHealthHandler(dependencies, payload))
      .handle("mintCredential", ({ payload }) => cloudMintCredentialHandler(dependencies, payload))
      .handle("t3MintCredential", ({ payload }) =>
        traceRelayRequest(cloudMintCredentialHandler(dependencies, payload)),
      );
  }),
);
