import * as NodeCrypto from "node:crypto";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
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
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticateOwnerSession, respondToAuthError } from "../auth/http.ts";
import { makeServerSecretStore } from "../auth/Layers/ServerSecretStore.ts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { CloudManagedEndpointRuntime } from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  encodeEndpointRuntimeConfigJson,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const CLOUD_LINK_PRIVATE_KEY = "cloud-link-ed25519-private-key";
const CLOUD_LINK_PUBLIC_KEY = "cloud-link-ed25519-public-key";
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

export const RelayEnvironmentConfigResponse = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type RelayEnvironmentConfigResponse = typeof RelayEnvironmentConfigResponse.Type;

export const RelayEnvironmentLinkStateResponse = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
});
export type RelayEnvironmentLinkStateResponse = typeof RelayEnvironmentLinkStateResponse.Type;

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

function validateCloudMintPublicKey(publicKey: string): Effect.Effect<void, AuthError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: (cause) =>
      new AuthError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
        status: 400,
        cause,
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new AuthError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
              status: 400,
            }),
          ),
    ),
  );
}

function isSecureRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, AuthError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new AuthError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
        status: 400,
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new AuthError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
        status: 400,
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new AuthError({
        message: "Relay environment credential is required.",
        status: 400,
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new AuthError({
        message: "Cloud user id is required.",
        status: 400,
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStoreShape;
  readonly cloudUserId: string;
}): Effect.Effect<void, AuthError> {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.flatMap((existing) => {
      if (!existing) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new AuthError({
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
              status: 409,
            }),
          );
    }),
    Effect.mapError((cause) =>
      cause instanceof AuthError
        ? cause
        : new AuthError({
            message: "Could not verify the linked cloud account.",
            status: 500,
            cause,
          }),
    ),
  );
}

function readInstalledCloudUserId(
  secrets: ServerSecretStoreShape,
): Effect.Effect<string, AuthError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : Effect.fail(
            new AuthError({
              message: "Cloud linked user is not installed for this environment.",
              status: 500,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof AuthError
        ? cause
        : new AuthError({
            message: "Could not read the linked cloud account.",
            status: 500,
            cause,
          }),
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

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStoreShape,
) {
  const existingPrivate = yield* secrets.get(CLOUD_LINK_PRIVATE_KEY);
  const existingPublic = yield* secrets.get(CLOUD_LINK_PUBLIC_KEY);
  if (existingPrivate && existingPublic) {
    return {
      privateKey: bytesToString(existingPrivate),
      publicKey: bytesToString(existingPublic),
    };
  }

  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  yield* secrets.set(CLOUD_LINK_PRIVATE_KEY, stringToBytes(keyPair.privateKey));
  yield* secrets.set(CLOUD_LINK_PUBLIC_KEY, stringToBytes(keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
});

export const getOrCreateEnvironmentKeyPair = Effect.gen(function* () {
  const secrets = yield* makeServerSecretStore;
  return yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
});

export const cloudLinkProofRouteLayer = HttpRouter.add(
  "POST",
  "/api/cloud/link-proof",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const environment = yield* ServerEnvironment;
    const keyPair = yield* getOrCreateEnvironmentKeyPair;
    const request = yield* HttpServerRequest.schemaBodyJson(RelayLinkProofRequest);
    const requestUrl = requestAbsoluteUrl(httpRequest);
    if (
      requestUrl === null ||
      hasForwardedAuthorityHeaders(httpRequest) ||
      !providerKindMatchesRequestedLinkScopes(request) ||
      !isAllowedEndpointOrigin({
        origin: request.origin,
        requestUrl,
      })
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Invalid managed endpoint origin." },
        { status: 400 },
      );
    }
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const descriptor = yield* environment.getDescriptor;
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
    const proof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_LINK_PROOF_TYP,
      payload,
    }).pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Failed to sign cloud link JWT.", status: 500, cause }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(proof satisfies RelayEnvironmentLinkProof, {
      status: 200,
      headers: CLOUD_CREDENTIAL_RESPONSE_HEADERS,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const cloudRelayConfigRouteLayer = HttpRouter.add(
  "POST",
  "/api/cloud/relay-config",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const secrets = yield* makeServerSecretStore;
    const payload = yield* HttpServerRequest.schemaBodyJson(RelayEnvironmentConfigRequest);
    yield* validateRelayConfigPayload(payload);
    yield* validateLinkedCloudUser({
      secrets,
      cloudUserId: payload.cloudUserId,
    });
    yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
    const endpointRuntime = yield* CloudManagedEndpointRuntime;
    const endpointRuntimeStatus = yield* endpointRuntime.applyConfig(payload.endpointRuntime);
    const ok =
      endpointRuntimeStatus.status === "disabled" || endpointRuntimeStatus.status === "running";
    if (!ok) {
      return HttpServerResponse.jsonUnsafe(
        { ok, endpointRuntimeStatus } satisfies RelayEnvironmentConfigResponse,
        { status: 503 },
      );
    }

    yield* secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
    yield* secrets.set(RELAY_ISSUER_SECRET, stringToBytes(payload.relayIssuer ?? payload.relayUrl));
    yield* secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
    yield* secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      stringToBytes(payload.environmentCredential),
    );
    yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
    if (payload.endpointRuntime) {
      const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
      yield* secrets.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, stringToBytes(endpointRuntimeJson));
    } else {
      yield* secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    }
    return HttpServerResponse.jsonUnsafe(
      { ok, endpointRuntimeStatus } satisfies RelayEnvironmentConfigResponse,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const cloudLinkStateRouteLayer = HttpRouter.add(
  "GET",
  "/api/cloud/link-state",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const secrets = yield* makeServerSecretStore;
    const [cloudUserId, relayUrl, relayIssuer] = yield* Effect.all(
      [
        secrets.get(CLOUD_LINKED_USER_ID),
        secrets.get(RELAY_URL_SECRET),
        secrets.get(RELAY_ISSUER_SECRET),
      ],
      { concurrency: 3 },
    );
    const response = {
      linked: cloudUserId !== null,
      cloudUserId: cloudUserId ? bytesToString(cloudUserId) : null,
      relayUrl: relayUrl ? bytesToString(relayUrl) : null,
      relayIssuer: relayIssuer ? bytesToString(relayIssuer) : null,
    } satisfies RelayEnvironmentLinkStateResponse;
    return HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const cloudUnlinkRouteLayer = HttpRouter.add(
  "POST",
  "/api/cloud/unlink",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const secrets = yield* makeServerSecretStore;
    const endpointRuntime = yield* CloudManagedEndpointRuntime;
    const endpointRuntimeStatus = yield* endpointRuntime.applyConfig(null);
    yield* Effect.all(
      [
        secrets.remove(CLOUD_LINKED_USER_ID),
        secrets.remove(RELAY_URL_SECRET),
        secrets.remove(RELAY_ISSUER_SECRET),
        secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        secrets.remove(CLOUD_MINT_PUBLIC_KEY),
        secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ],
      { concurrency: 6 },
    );
    return HttpServerResponse.jsonUnsafe(
      { ok: true, endpointRuntimeStatus } satisfies RelayEnvironmentConfigResponse,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const cloudEnvironmentHealthHandler = Effect.gen(function* () {
  const secrets = yield* makeServerSecretStore;
  const environment = yield* ServerEnvironment;
  const keyPair = yield* getOrCreateEnvironmentKeyPair;
  const cloudMintPublicKey = yield* secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : Effect.fail(
            new AuthError({
              message: "Cloud mint public key is not installed for this environment.",
              status: 500,
            }),
          ),
    ),
  );
  const relayIssuer = yield* secrets.get(RELAY_ISSUER_SECRET).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : secrets.get(RELAY_URL_SECRET).pipe(
            Effect.flatMap((fallbackBytes) =>
              fallbackBytes
                ? Effect.succeed(bytesToString(fallbackBytes))
                : Effect.fail(
                    new AuthError({
                      message: "Cloud relay issuer is not installed for this environment.",
                      status: 500,
                    }),
                  ),
            ),
          ),
    ),
  );
  const request = yield* HttpServerRequest.schemaBodyJson(RelayCloudEnvironmentHealthRequest);
  const environmentId = yield* environment.getEnvironmentId;
  const linkedCloudUserId = yield* readInstalledCloudUserId(secrets);
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
    return HttpServerResponse.jsonUnsafe(
      { error: "Invalid cloud health request." },
      { status: 401 },
    );
  }
  const proof = proofOption.value;

  const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
  const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
  const consumedReplayGuards = yield* Effect.all(
    [
      secrets.create(jtiSecretName, stringToBytes(DateTime.formatIso(now))),
      secrets.create(nonceSecretName, stringToBytes(DateTime.formatIso(now))),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.as(true),
    Effect.catchTag("SecretStoreError", () => Effect.succeed(false)),
  );
  if (!consumedReplayGuards) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Cloud health request was already consumed." },
      { status: 409 },
    );
  }

  const descriptor = yield* environment.getDescriptor;
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
  } satisfies typeof RelayEnvironmentHealthResponseProofPayload.Type;
  const responseProof = yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_HEALTH_RESPONSE_TYP,
    payload: responsePayload,
  }).pipe(
    Effect.mapError(
      (cause) => new AuthError({ message: "Failed to sign cloud health JWT.", status: 500, cause }),
    ),
  );
  const response = {
    environmentId,
    status: "online",
    descriptor,
    checkedAt: responsePayload.checkedAt,
    proof: responseProof,
  } satisfies RelayEnvironmentHealthResponseShape;

  return HttpServerResponse.jsonUnsafe(response, {
    status: 200,
    headers: CLOUD_CREDENTIAL_RESPONSE_HEADERS,
  });
}).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error)));

export const cloudEnvironmentHealthRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3-cloud/health",
  cloudEnvironmentHealthHandler,
);

const cloudMintCredentialHandler = Effect.gen(function* () {
  const secrets = yield* makeServerSecretStore;
  const environment = yield* ServerEnvironment;
  const authControlPlane = yield* AuthControlPlane;
  const keyPair = yield* getOrCreateEnvironmentKeyPair;
  const cloudMintPublicKey = yield* secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : Effect.fail(
            new AuthError({
              message: "Cloud mint public key is not installed for this environment.",
              status: 500,
            }),
          ),
    ),
  );
  const relayIssuer = yield* secrets.get(RELAY_ISSUER_SECRET).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : secrets.get(RELAY_URL_SECRET).pipe(
            Effect.flatMap((fallbackBytes) =>
              fallbackBytes
                ? Effect.succeed(bytesToString(fallbackBytes))
                : Effect.fail(
                    new AuthError({
                      message: "Cloud relay issuer is not installed for this environment.",
                      status: 500,
                    }),
                  ),
            ),
          ),
    ),
  );
  const request = yield* HttpServerRequest.schemaBodyJson(RelayCloudMintCredentialRequest);
  const environmentId = yield* environment.getEnvironmentId;
  const linkedCloudUserId = yield* readInstalledCloudUserId(secrets);
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
    return HttpServerResponse.jsonUnsafe({ error: "Invalid cloud mint request." }, { status: 401 });
  }
  const proof = proofOption.value;

  const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
  const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
  const consumedReplayGuards = yield* Effect.all(
    [
      secrets.create(jtiSecretName, stringToBytes(DateTime.formatIso(now))),
      secrets.create(nonceSecretName, stringToBytes(DateTime.formatIso(now))),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.as(true),
    Effect.catchTag("SecretStoreError", () => Effect.succeed(false)),
  );
  if (!consumedReplayGuards) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Cloud mint request was already consumed." },
      { status: 409 },
    );
  }

  const issued = yield* authControlPlane.createPairingLink({
    role: "client",
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
  } satisfies typeof RelayEnvironmentMintResponseProofPayload.Type;
  const responseProof = yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_MINT_RESPONSE_TYP,
    payload: responsePayload,
  }).pipe(
    Effect.mapError(
      (cause) => new AuthError({ message: "Failed to sign cloud mint JWT.", status: 500, cause }),
    ),
  );
  const response = {
    credential: issued.credential,
    expiresAt: DateTime.formatIso(issued.expiresAt),
    proof: responseProof,
  } satisfies RelayEnvironmentMintResponseShape;

  return HttpServerResponse.jsonUnsafe(response, {
    status: 200,
    headers: CLOUD_CREDENTIAL_RESPONSE_HEADERS,
  });
}).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error)));

export const cloudMintCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/cloud/mint-credential",
  cloudMintCredentialHandler,
);

export const cloudT3MintCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/t3-cloud/mint-credential",
  cloudMintCredentialHandler,
);
