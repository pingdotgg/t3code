import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";

import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudMintCredentialProofPayload,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentHealthResponseProofPayload,
  RelayEnvironmentMintResponse,
  RelayEnvironmentMintResponseProofPayload,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { RELAY_HEALTH_RESPONSE_TYP, RELAY_MINT_RESPONSE_TYP } from "@t3tools/shared/relayJwt";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentConnector from "./EnvironmentConnector.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const cloudKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const otherEnvironmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const decodeHealthRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayCloudEnvironmentHealthRequest),
);
const decodeMintRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(RelayCloudMintCredentialRequest),
);
const isEnvironmentConnectNotAuthorized = Schema.is(
  EnvironmentConnector.EnvironmentConnectNotAuthorized,
);

function requestBodyText(request: HttpClientRequest.HttpClientRequest): string {
  return request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
}

const settings = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  cloudMintPrivateKey: Redacted.make(cloudKeyPair.privateKey),
  cloudMintPublicKey: cloudKeyPair.publicKey,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: undefined,
});

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${encodedPayload}`;
  return `${input}.${NodeCrypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

function decodeRequestProof<T>(proof: string): T {
  const payload = proof.split(".")[1];
  if (!payload) throw new Error("Missing JWT payload.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

function signMintResponse(
  request: RelayCloudMintCredentialRequest,
  overrides: Partial<RelayEnvironmentMintResponseProofPayload> = {},
  privateKey = environmentKeyPair.privateKey,
): RelayEnvironmentMintResponse {
  const requestProof = decodeRequestProof<RelayCloudMintCredentialProofPayload>(request.proof);
  const payload = {
    iss: `t3-env:${requestProof.environmentId}`,
    aud: "https://relay.example.test",
    sub: requestProof.environmentId,
    jti: "mint-response-jti",
    iat: requestProof.iat,
    exp: requestProof.exp,
    environmentId: requestProof.environmentId,
    clientProofKeyThumbprint: requestProof.clientProofKeyThumbprint,
    requestNonce: requestProof.nonce,
    credential: "pairing_credential",
    ...overrides,
  } satisfies RelayEnvironmentMintResponseProofPayload;
  return {
    credential: payload.credential,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(payload.exp * 1_000)),
    proof: signTestJwt(payload, RELAY_MINT_RESPONSE_TYP, privateKey),
  };
}

function signHealthResponse(
  request: RelayCloudEnvironmentHealthRequest,
  privateKey = environmentKeyPair.privateKey,
  overrides: Partial<RelayEnvironmentHealthResponse> = {},
  payloadOverrides: Partial<RelayEnvironmentHealthResponseProofPayload> = {},
): RelayEnvironmentHealthResponse {
  const requestProof = decodeRequestProof<RelayCloudEnvironmentHealthProofPayload>(request.proof);
  const payload = {
    iss: `t3-env:${requestProof.environmentId}`,
    aud: "https://relay.example.test",
    sub: requestProof.environmentId,
    jti: "health-response-jti",
    iat: requestProof.iat,
    exp: requestProof.exp,
    environmentId: requestProof.environmentId,
    requestNonce: requestProof.nonce,
    status: "online",
    descriptor: {
      environmentId: requestProof.environmentId,
      label: "Connector Test Environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(requestProof.iat * 1_000)),
    ...payloadOverrides,
  } satisfies RelayEnvironmentHealthResponseProofPayload;
  return {
    environmentId: payload.environmentId,
    status: "online",
    descriptor: payload.descriptor,
    checkedAt: payload.checkedAt,
    proof: signTestJwt(payload, RELAY_HEALTH_RESPONSE_TYP, privateKey),
    ...overrides,
  };
}

function connectorTestLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  options?: {
    readonly links?: EnvironmentLinks.EnvironmentLinksShape;
    readonly allocations?: ManagedEndpointAllocations.ManagedEndpointAllocationsShape;
  },
) {
  return EnvironmentConnector.layer.pipe(
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provide(Layer.succeed(EnvironmentLinks.EnvironmentLinks, options?.links ?? makeLinks())),
    Layer.provide(
      Layer.succeed(
        ManagedEndpointAllocations.ManagedEndpointAllocations,
        options?.allocations ?? makeAllocations(),
      ),
    ),
    Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, settings)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  );
}

function makeAllocations(
  allocation: ManagedEndpointAllocations.ManagedEndpointAllocation | null = {
    userId: "user_123",
    environmentId: "env-connector-test",
    hostname: "env.example.test",
    tunnelId: "tunnel-id",
    tunnelName: "tunnel-name",
    dnsRecordId: "dns-record-id",
    readyAt: "2026-05-25T00:00:00.000Z",
  },
): ManagedEndpointAllocations.ManagedEndpointAllocationsShape {
  return {
    get: () => Effect.succeed(allocation),
    reserve: () => Effect.die("unused"),
    recordTunnel: () => Effect.die("unused"),
    recordDns: () => Effect.die("unused"),
    markReady: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  };
}

function makeLinks(
  overrides: Partial<EnvironmentLinks.RelayLinkedEnvironmentRecord> = {},
): EnvironmentLinks.EnvironmentLinksShape {
  return {
    upsert: () => Effect.void,
    listUsersForEnvironment: () => Effect.succeed([]),
    listDeliveryUsersForEnvironment: () => Effect.succeed([]),
    listPublicKeysForEnvironment: () => Effect.succeed([environmentKeyPair.publicKey]),
    listForUser: () => Effect.succeed([]),
    getForUser: () =>
      Effect.succeed({
        environmentId: "env-connector-test" as never,
        label: "Connector Test Environment",
        endpoint: {
          httpBaseUrl: "https://env.example.test/",
          wsBaseUrl: "wss://env.example.test/ws",
          providerKind: "cloudflare_tunnel",
        },
        linkedAt: "2026-05-25T00:00:00.000Z",
        environmentPublicKey: environmentKeyPair.publicKey,
        ...overrides,
      }),
    revokeForUser: () => Effect.succeed(false),
  };
}

describe("EnvironmentConnector", () => {
  it.effect("checks linked environment health through the managed endpoint", () => {
    const seenUrls: Array<string> = [];
    const seenProofs: Array<RelayCloudEnvironmentHealthProofPayload> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        seenProofs.push(decodeRequestProof(healthRequest.proof));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signHealthResponse(healthRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-cloud/health"]);
      expect(seenProofs[0]).toMatchObject({
        iss: "https://relay.example.test",
        aud: "t3-env:env-connector-test",
        sub: "user_123",
        environmentId: "env-connector-test",
        scope: ["environment:status"],
      });
      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        status: "online",
        descriptor: {
          environmentId: "env-connector-test",
          label: "Connector Test Environment",
        },
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects manual endpoints before sending a health request", () => {
    let requestCount = 0;
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "status",
            reason: "endpoint_provider_not_managed",
          });
        }
      }
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            endpoint: {
              httpBaseUrl: "https://127.0.0.1/",
              wsBaseUrl: "wss://127.0.0.1/ws",
              providerKind: "manual",
            },
          }),
        }),
      ),
    );
  });

  it.effect("rejects stale managed endpoints before sending a mint request", () => {
    let requestCount = 0;
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "connect",
            reason: "managed_endpoint_mismatch",
          });
        }
      }
      const resolutionSpan = spans.find(
        (span) => span.name === "relay.environment_connector.resolve_managed_endpoint",
      );
      expect(Object.fromEntries(resolutionSpan?.attributes ?? [])).toMatchObject({
        "relay.authorization.allocation_hostname": "env.example.test",
        "relay.authorization.allocation_has_ready_at": true,
        "relay.authorization.allocation_has_tunnel_id": true,
        "relay.authorization.allocation_has_dns_record_id": true,
        "relay.authorization.linked_http_base_url": "https://attacker.example.test/",
        "relay.authorization.linked_ws_base_url": "wss://attacker.example.test/ws",
        "relay.authorization.resolved_http_base_url": "https://env.example.test/",
        "relay.authorization.resolved_ws_base_url": "wss://env.example.test/ws",
      });
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            endpoint: {
              httpBaseUrl: "https://attacker.example.test/",
              wsBaseUrl: "wss://attacker.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
          }),
        }),
      ),
      Effect.provideService(Tracer.Tracer, tracer),
    );
  });

  it.effect("rejects unready managed endpoint allocations before sending a request", () => {
    let requestCount = 0;
    const execute = () =>
      Effect.sync(() => {
        requestCount += 1;
        throw new Error("unexpected request");
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.result(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentConnectNotAuthorized(result.failure)).toBe(true);
        if (isEnvironmentConnectNotAuthorized(result.failure)) {
          expect(result.failure).toMatchObject({
            operation: "status",
            reason: "managed_endpoint_allocation_not_ready",
          });
        }
      }
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          allocations: makeAllocations({
            userId: "user_123",
            environmentId: "env-connector-test",
            hostname: "env.example.test",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
            dnsRecordId: "dns-record-id",
            readyAt: null,
          }),
        }),
      ),
    );
  });

  it.effect("rejects signed health responses with stale checkedAt timestamps", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signHealthResponse(
              healthRequest,
              environmentKeyPair.privateKey,
              {},
              {
                checkedAt: "2026-05-24T00:00:00.000Z",
              },
            ),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("reports offline status when the managed endpoint health request fails", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              _tag: "EnvironmentHttpInternalServerError",
              message: "Environment is unavailable.",
            },
            { status: 500 },
          ),
        ),
      );

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });

      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        status: "offline",
        error: "Managed endpoint health request failed: Environment is unavailable.",
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses with a mismatched top-level environment id", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signHealthResponse(healthRequest, environmentKeyPair.privateKey, {
              environmentId: "other-env" as RelayEnvironmentHealthResponse["environmentId"],
            }),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses with an unsigned top-level descriptor mutation", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        const response = signHealthResponse(healthRequest);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              ...response,
              descriptor: {
                ...response.descriptor,
                label: "Tampered Environment Label",
              },
            } satisfies RelayEnvironmentHealthResponse,
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects health responses when the linked environment public key is malformed", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signHealthResponse(healthRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            environmentPublicKey: "not a pem public key",
          }),
        }),
      ),
    );
  });

  it.effect("mints a one-time environment credential through the linked endpoint", () => {
    const seenUrls: Array<string> = [];
    const seenProofs: Array<RelayCloudMintCredentialProofPayload> = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        seenUrls.push(request.url);
        seenProofs.push(decodeRequestProof(mintRequest.proof));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.connect({
        userId: "user_123",
        environmentId: "env-connector-test",
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        deviceId: "device-123",
      });

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-cloud/mint-credential"]);
      expect(seenProofs[0]).toMatchObject({
        iss: "https://relay.example.test",
        aud: "t3-env:env-connector-test",
        sub: "user_123",
        environmentId: "env-connector-test",
        clientProofKeyThumbprint: "client-proof-key-thumbprint",
        cnf: { jkt: "client-proof-key-thumbprint" },
        deviceId: "device-123",
        scope: ["environment:connect"],
      });
      expect(result).toMatchObject({
        environmentId: "env-connector-test",
        credential: "pairing_credential",
        endpoint: {
          httpBaseUrl: "https://env.example.test/",
          wsBaseUrl: "wss://env.example.test/ws",
        },
      });
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("only accepts mint responses signed by the user's linked environment key", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest, {}, otherEnvironmentKeyPair.privateKey), {
            status: 200,
          }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("rejects mint responses when the linked environment public key is malformed", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(signMintResponse(mintRequest), { status: 200 }),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(
      Effect.provide(
        connectorTestLayer(execute, {
          links: makeLinks({
            environmentPublicKey: "not a pem public key",
          }),
        }),
      ),
    );
  });

  it.effect("rejects environment mint responses with an overlong credential window", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const mintRequest = decodeMintRequestBody(requestBodyText(request));
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { ...signMintResponse(mintRequest), expiresAt: "2999-01-01T00:00:00.000Z" },
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* Effect.exit(
        connector.connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("EnvironmentMintResponseInvalid");
      }
    }).pipe(Effect.provide(connectorTestLayer(execute)));
  });

  it.effect("times out hung managed endpoint mint requests", () => {
    let resolveRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      resolveRequestStarted = () => resolve();
    });
    const execute = () =>
      Effect.sync(() => {
        resolveRequestStarted?.();
      }).pipe(Effect.andThen(Effect.never as Effect.Effect<HttpClientResponse.HttpClientResponse>));

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const resultFiber = yield* connector
        .connect({
          userId: "user_123",
          environmentId: "env-connector-test",
          clientProofKeyThumbprint: "client-proof-key-thumbprint",
        })
        .pipe(Effect.result, Effect.forkScoped);

      yield* Effect.promise(() => requestStarted);
      yield* TestClock.adjust(
        Duration.millis(EnvironmentConnector.ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS),
      );
      const result = yield* Fiber.join(resultFiber);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("EnvironmentMintRequestTimedOut");
        expect(result.failure).toMatchObject({
          environmentId: "env-connector-test",
          timeoutMs: EnvironmentConnector.ENVIRONMENT_MINT_REQUEST_TIMEOUT_MS,
        });
      }
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), connectorTestLayer(execute))));
  });
});
