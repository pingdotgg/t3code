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
  EnvironmentHttpInternalServerError,
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
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "../environment/Services/ServerEnvironment.ts";
import {
  CloudManagedEndpointRuntime,
  type CloudManagedEndpointRuntimeShape,
} from "./ManagedEndpointRuntime.ts";
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
import * as CliState from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";

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

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    () =>
      new EnvironmentHttpInternalServerError({
        message: "MORECODE_T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
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
  readonly secrets: ServerSecretStore.ServerSecretStoreShape;
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.all(
    input.names.map((name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchTag("SecretStoreError", (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
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
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
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
        message: "Relay URL must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay environment credential is required.",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Cloud user id is required.",
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStore.ServerSecretStoreShape;
  readonly cloudUserId: string;
}): Effect.Effect<void, EnvironmentAuth.ServerAuthInternalError | EnvironmentHttpConflictError> {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthInternalError({
          message: "Could not verify the linked cloud account.",
          cause,
        }),
    ),
    Effect.flatMap((existing) => {
      if (!existing) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpConflictError({
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
            }),
          );
    }),
  );
}

function readInstalledCloudUserId(
  secrets: ServerSecretStore.ServerSecretStoreShape,
): Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthInternalError({
          message: "Could not read the linked cloud account.",
          cause,
        }),
    ),
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : Effect.fail(
            new EnvironmentAuth.ServerAuthInternalError({
              message: "Cloud linked user is not installed for this environment.",
            }),
          ),
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
  readonly secrets: ServerSecretStore.ServerSecretStoreShape;
  readonly environment: ServerEnvironmentShape;
  readonly endpointRuntime: CloudManagedEndpointRuntimeShape;
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuthShape;
  readonly cliTokenManager: CliTokenManager.CloudCliTokenManagerShape;
  readonly httpClient: HttpClient.HttpClient;
}

const cloudHttpDependencies = Effect.gen(function* () {
  return {
    secrets: yield* ServerSecretStore.ServerSecretStore,
    environment: yield* ServerEnvironment,
    endpointRuntime: yield* CloudManagedEndpointRuntime,
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
      message: "Invalid managed endpoint origin.",
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
        new EnvironmentAuth.ServerAuthInternalError({
          message: "Failed to sign cloud link JWT.",
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
        message: "Invalid managed endpoint origin.",
      });
    }
    const proof = yield* makeCloudLinkProof(dependencies, request, requestUrl);
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchTag("ServerAuthInternalError", (error) =>
    failEnvironmentCloudInternalError(error.message)(error.cause),
  ),
  Effect.catchTags({
    PlatformError: failEnvironmentCloudInternalError("Could not generate environment link proof."),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not generate environment link proof.",
    ),
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
      message: "Managed endpoint runtime could not be started.",
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
  Effect.catchTag("ServerAuthInternalError", (error) =>
    failEnvironmentCloudInternalError(error.message)(error.cause),
  ),
  Effect.catchTags({
    SchemaError: failEnvironmentCloudInternalError(
      "Could not persist environment relay configuration.",
    ),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not persist environment relay configuration.",
    ),
  }),
);

const relayClientRequest = <A>(
  dependencies: CloudHttpDependencies,
  input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
  },
) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.bodyJson(input.payload),
    Effect.flatMap(dependencies.httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    Effect.mapError(
      (cause) =>
        new EnvironmentHttpInternalServerError({
          message: `T3 Cloud relay request failed: ${String(cause)}`,
        }),
    ),
  );

const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
  function* (dependencies: CloudHttpDependencies, localOrigin: string) {
    const localUrl = yield* Effect.try({
      try: () => new URL(localOrigin),
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
    });
    if (localUrl.origin !== localOrigin) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Could not resolve local environment origin.",
      });
    }
    const localWsOrigin = localOrigin.replace(/^http/u, "ws");
    const token = yield* dependencies.cliTokenManager.getExisting.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                message: "Run `t3 cloud link` to authorize this environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const relayUrl = yield* requireRelayUrl;
    const challenge = yield* relayClientRequest(dependencies, {
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
    yield* CliState.setCliDesiredCloudLink(true);
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
    CloudCliTokenManagerError: (error) =>
      failEnvironmentCloudInternalError(error.message)(error.cause),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not persist desired T3 Cloud link state.",
    ),
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
    linked: cloudUserId !== null,
    cloudUserId: cloudUserId ? bytesToString(cloudUserId) : null,
    relayUrl: relayUrl ? bytesToString(relayUrl) : null,
    relayIssuer: relayIssuer ? bytesToString(relayIssuer) : null,
    publishAgentActivity: publishAgentActivity
      ? bytesToString(publishAgentActivity) === "true"
      : false,
  } satisfies EnvironmentCloudLinkStateResult;
});

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    return yield* readCloudLinkState(dependencies);
  },
  Effect.catchTag(
    "SecretStoreError",
    failEnvironmentCloudInternalError("Could not read environment relay configuration."),
  ),
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
    yield* CliState.setCliDesiredCloudLink(false);
    return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchTag(
    "SecretStoreError",
    failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
  ),
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
  Effect.catchTag(
    "SecretStoreError",
    failEnvironmentCloudInternalError("Could not persist environment cloud preferences."),
  ),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : Effect.fail(
              new EnvironmentAuth.ServerAuthInternalError({
                message: "Cloud mint public key is not installed for this environment.",
              }),
            ),
      ),
    );
    const relayIssuer = yield* dependencies.secrets.get(RELAY_ISSUER_SECRET).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : dependencies.secrets.get(RELAY_URL_SECRET).pipe(
              Effect.flatMap((fallbackBytes) =>
                fallbackBytes
                  ? Effect.succeed(bytesToString(fallbackBytes))
                  : Effect.fail(
                      new EnvironmentAuth.ServerAuthInternalError({
                        message: "Cloud relay issuer is not installed for this environment.",
                      }),
                    ),
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
        message: "Invalid cloud health request.",
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
        message: "Cloud health request was already consumed.",
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
          new EnvironmentAuth.ServerAuthInternalError({
            message: "Failed to sign cloud health JWT.",
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
  Effect.catchTag("ServerAuthInternalError", (error) =>
    failEnvironmentCloudInternalError(error.message)(error.cause),
  ),
  Effect.catchTags({
    PlatformError: failEnvironmentCloudInternalError("Could not answer cloud health request."),
    SecretStoreError: failEnvironmentCloudInternalError("Could not answer cloud health request."),
  }),
);

const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : Effect.fail(
              new EnvironmentAuth.ServerAuthInternalError({
                message: "Cloud mint public key is not installed for this environment.",
              }),
            ),
      ),
    );
    const relayIssuer = yield* dependencies.secrets.get(RELAY_ISSUER_SECRET).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : dependencies.secrets.get(RELAY_URL_SECRET).pipe(
              Effect.flatMap((fallbackBytes) =>
                fallbackBytes
                  ? Effect.succeed(bytesToString(fallbackBytes))
                  : Effect.fail(
                      new EnvironmentAuth.ServerAuthInternalError({
                        message: "Cloud relay issuer is not installed for this environment.",
                      }),
                    ),
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
        message: "Invalid cloud mint request.",
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
        message: "Cloud mint request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const issued = yield* dependencies.environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "cloud-connect",
      ttl: Duration.minutes(2),
      label: "T3 Cloud connect",
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
          new EnvironmentAuth.ServerAuthInternalError({
            message: "Failed to sign cloud mint JWT.",
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
  Effect.catchTag("ServerAuthInternalError", (error) =>
    failEnvironmentCloudInternalError(error.message)(error.cause),
  ),
  Effect.catchTags({
    PlatformError: failEnvironmentCloudInternalError(
      "Could not issue cloud connection credential.",
    ),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not issue cloud connection credential.",
    ),
  }),
);

export const cloudHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cloud",
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
        cloudMintCredentialHandler(dependencies, payload),
      );
  }),
);
