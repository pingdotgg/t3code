// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
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
import * as Deferred from "effect/Deferred";
import { RELAY_HEALTH_RESPONSE_TYP, RELAY_MINT_RESPONSE_TYP } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

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

function layerConnectorTest(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  options?: {
    readonly links?: EnvironmentLinks.EnvironmentLinks["Service"];
    readonly allocations?: ManagedEndpointAllocations.ManagedEndpointAllocations["Service"];
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
    Layer.provide(RelayConfiguration.layer(settings)),
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
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    updatedAt: "2026-05-25T00:00:00.000Z",
    generation: 1,
    tunnelReleasedAt: null,
  },
): ManagedEndpointAllocations.ManagedEndpointAllocations["Service"] {
  return {
    getByTunnelName: () => Effect.die("unused getByTunnelName"),
    get: () => Effect.succeed(allocation),
    reserve: () => Effect.die("unused"),
    recordTunnel: () => Effect.die("unused"),
    recordDns: () => Effect.die("unused"),
    markReady: () => Effect.die("unused"),
    enableRecovery: () => Effect.die("unused"),
    listByTunnelNames: () => Effect.die("unused"),
    claimRelease: () => Effect.die("unused"),
    withClaimedTunnel: () => Effect.die("unused"),
    claimDeprovision: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    removeClaimed: () => Effect.die("unused"),
  };
}

function makeLinks(
  overrides: Partial<EnvironmentLinks.RelayLinkedEnvironmentRecord> = {},
): EnvironmentLinks.EnvironmentLinks["Service"] {
  return {
    upsert: () => Effect.void,
    listDeliveryUsersForEnvironment: () => Effect.succeed([]),
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
    findActiveManagedForEnvironment: () => Effect.succeed([]),
    setHoldWebhooksWhileOffline: () => Effect.void,
    updateLabel: () => Effect.void,
    recordEnvironmentLabel: () => Effect.void,
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

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-connect/health"]);
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
  });

  it.effect.each([
    { persistenceFails: false, storedLabel: "Connector Test Environment" },
    { persistenceFails: true, storedLabel: "Connector Test Environment" },
    { persistenceFails: false, storedLabel: "Studio Mac" },
    { persistenceFails: true, storedLabel: "Studio Mac" },
  ])(
    "records the verified label, timestamp and captured key, retaining health on persistence failure: %s",
    ({ persistenceFails, storedLabel }) => {
      const updates: Array<
        Parameters<EnvironmentLinks.EnvironmentLinks["Service"]["updateLabel"]>[0]
      > = [];
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
                  descriptor: {
                    environmentId: "env-connector-test" as never,
                    label: "Studio Mac",
                    platform: { os: "darwin", arch: "arm64" },
                    serverVersion: "0.0.0-test",
                    capabilities: { repositoryIdentity: true },
                  },
                },
              ),
              { status: 200 },
            ),
          );
        });
      const links = makeLinks({ label: storedLabel });

      return Effect.gen(function* () {
        const connector = yield* EnvironmentConnector.EnvironmentConnector;
        const result = yield* connector.status({
          userId: "user_123",
          environmentId: "env-connector-test",
        });

        expect(result.descriptor?.label).toBe("Studio Mac");
        expect(updates).toEqual([
          {
            userId: "user_123",
            environmentId: "env-connector-test",
            environmentPublicKey: environmentKeyPair.publicKey,
            label: "Studio Mac",
            checkedAt: expect.any(String),
          },
        ]);
      }).pipe(
        Effect.provide(
          layerConnectorTest(execute, {
            links: {
              ...links,
              updateLabel: (input) =>
                Effect.gen(function* () {
                  updates.push(input);
                  if (persistenceFails) {
                    return yield* new EnvironmentLinks.EnvironmentLinkLabelUpdatePersistenceError({
                      environmentId: input.environmentId,
                      cause: new Error("database unavailable"),
                    });
                  }
                }),
            },
          }),
        ),
      );
    },
  );

  it.effect("persists a verified rename using relay time when the host clock is behind", () => {
    const relayCheckedAt = "2026-08-20T12:00:30.000Z";
    const hostCheckedAt = "2026-08-20T12:00:00.000Z";
    const linkedAt = "2026-08-20T12:00:20.000Z";
    const updates: Array<
      Parameters<EnvironmentLinks.EnvironmentLinks["Service"]["updateLabel"]>[0]
    > = [];
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const healthRequest = decodeHealthRequestBody(requestBodyText(request));
        const requestProof = decodeRequestProof<RelayCloudEnvironmentHealthProofPayload>(
          healthRequest.proof,
        );
        const response = signHealthResponse(healthRequest);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signHealthResponse(
              healthRequest,
              environmentKeyPair.privateKey,
              {},
              {
                iat: requestProof.iat - 30,
                exp: requestProof.exp - 30,
                checkedAt: hostCheckedAt,
                descriptor: { ...response.descriptor, label: "Studio Mac" },
              },
            ),
            { status: 200 },
          ),
        );
      });

    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(relayCheckedAt));
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });
      expect(result).toMatchObject({
        status: "online",
        checkedAt: hostCheckedAt,
        descriptor: { label: "Studio Mac" },
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]?.checkedAt).toBe(relayCheckedAt);
      expect(Date.parse(updates[0]?.checkedAt ?? "")).toBeGreaterThan(Date.parse(linkedAt));
      expect(Date.parse(hostCheckedAt)).toBeLessThan(Date.parse(linkedAt));
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          layerConnectorTest(execute, {
            links: {
              ...makeLinks({ linkedAt }),
              updateLabel: (input) =>
                Effect.sync(() => {
                  updates.push(input);
                }),
            },
          }),
        ),
      ),
    );
  });

  it.effect("orders delayed rename and unchanged reset probes by their relay start time", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const updates: Array<
        Parameters<EnvironmentLinks.EnvironmentLinks["Service"]["updateLabel"]>[0]
      > = [];
      let requests = 0;
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const first = ++requests === 1;
          const healthRequest = decodeHealthRequestBody(requestBodyText(request));
          const requestProof = decodeRequestProof<RelayCloudEnvironmentHealthProofPayload>(
            healthRequest.proof,
          );
          const response = signHealthResponse(healthRequest);
          const checkedAt = DateTime.formatIso(
            DateTime.makeUnsafe((requestProof.iat + (first ? 30 : -30)) * 1_000),
          );
          if (first) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              signHealthResponse(
                healthRequest,
                environmentKeyPair.privateKey,
                {},
                {
                  checkedAt,
                  descriptor: {
                    ...response.descriptor,
                    label: first ? "Studio Mac" : "Connector Test Environment",
                  },
                },
              ),
              { status: 200 },
            ),
          );
        });
      const checks = Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-08-20T12:00:30.000Z"));
        const connector = yield* EnvironmentConnector.EnvironmentConnector;
        const statusInput = { userId: "user_123", environmentId: "env-connector-test" };
        const older = yield* connector.status(statusInput).pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust("5 seconds");
        const newer = yield* connector.status(statusInput);
        yield* Deferred.succeed(releaseFirst, undefined);
        const olderResult = yield* Fiber.join(older);
        // Completion order and host timestamps both disagree with relay probe order.
        expect(Date.parse(olderResult.checkedAt)).toBeGreaterThan(Date.parse(newer.checkedAt));
        expect(updates.map(({ label, checkedAt }) => ({ label, checkedAt }))).toEqual([
          { label: "Connector Test Environment", checkedAt: "2026-08-20T12:00:35.000Z" },
          { label: "Studio Mac", checkedAt: "2026-08-20T12:00:30.000Z" },
        ]);
      });
      yield* checks.pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            layerConnectorTest(execute, {
              links: {
                ...makeLinks(),
                updateLabel: (input) =>
                  Effect.sync(() => {
                    updates.push(input);
                  }),
              },
            }),
          ),
        ),
      );
    }),
  );

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
        layerConnectorTest(execute, {
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
        layerConnectorTest(execute, {
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
        layerConnectorTest(execute, {
          allocations: makeAllocations({
            userId: "user_123",
            environmentId: "env-connector-test",
            hostname: "env.example.test",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
            dnsRecordId: "dns-record-id",
            readyAt: null,
            origin: null,
            updatedAt: "2026-05-25T00:00:00.000Z",
            generation: 1,
            tunnelReleasedAt: null,
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
  });

  it.effect("reports a released tunnel as the reason an environment is offline", () => {
    const execute = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("tunnel not found", { status: 530 })),
      );
    const allocations = makeAllocations({
      userId: "user_123",
      environmentId: "env-connector-test",
      hostname: "env.example.test",
      tunnelId: "tunnel-id",
      tunnelName: "tunnel-name",
      dnsRecordId: "dns-record-id",
      readyAt: "2026-05-25T00:00:00.000Z",
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      updatedAt: "2026-05-25T00:00:00.000Z",
      generation: 2,
      tunnelReleasedAt: "2026-05-26T00:00:00.000Z",
    });

    return Effect.gen(function* () {
      const connector = yield* EnvironmentConnector.EnvironmentConnector;
      const result = yield* connector.status({
        userId: "user_123",
        environmentId: "env-connector-test",
      });

      expect(result).toMatchObject({ status: "offline", offlineReason: "tunnel_released" });
    }).pipe(Effect.provide(layerConnectorTest(execute, { allocations })));
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
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
        layerConnectorTest(execute, {
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

      expect(seenUrls).toEqual(["https://env.example.test/api/t3-connect/mint-credential"]);
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
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
    }).pipe(Effect.provide(layerConnectorTest(execute)));
  });
});
