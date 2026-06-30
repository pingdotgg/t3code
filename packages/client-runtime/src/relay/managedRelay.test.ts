import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentStatusScope } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "./managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";

function managedRelayTestLayer(
  fetchFn: typeof globalThis.fetch,
  relayUrl = "https://relay.example.test",
  accessTokenStore?: ManagedRelay.ManagedRelayAccessTokenStore,
) {
  const httpClientLayer = remoteHttpClientLayer(fetchFn);
  const signerLayer = Layer.succeed(
    ManagedRelay.ManagedRelayDpopSigner,
    ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("client-thumbprint"),
      createProof: (input: ManagedRelay.ManagedRelayDpopProofInput) =>
        Effect.succeed(`proof:${input.url}`),
    }),
  );
  return ManagedRelay.layer({
    relayUrl,
    clientId: "t3-mobile",
    ...(accessTokenStore ? { accessTokenStore } : {}),
  }).pipe(Layer.provide(signerLayer), Layer.provide(httpClientLayer));
}

function clerkToken(subject: string, nonce: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ sub: subject, nonce })}.signature`;
}

describe("ManagedRelayClient", () => {
  it.effect("owns tracing at service and implementation boundaries", () => {
    const spanNames: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spanNames.push(span.name);
        return span;
      },
    });
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        return Promise.resolve(
          Response.json({
            access_token: "relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.getEnvironmentStatus({
        clerkToken: clerkToken("user-1", "session-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(spanNames).toEqual(
        expect.arrayContaining([
          "clientRuntime.managedRelay.getEnvironmentStatus",
          "clientRuntime.managedRelay.authorize",
          "clientRuntime.managedRelay.obtainAccessToken",
          "clientRuntime.managedRelay.tokenCacheCriticalSection",
          "clientRuntime.managedRelay.exchangeAccessToken",
        ]),
      );
      expect(spanNames).not.toEqual(
        expect.arrayContaining([
          "clientRuntime.managedRelay.createTokenExchangeProof",
          "clientRuntime.managedRelay.exchangeAccessTokenRequest",
          "clientRuntime.managedRelay.createRequestProof",
        ]),
      );
    }).pipe(Effect.withTracer(tracer), Effect.provide(managedRelayTestLayer(fetchFn)));
  });

  it.effect("rejects unsafe relay URLs before sending credentials", () => {
    let requestCount = 0;
    const fetchFn = (() => {
      requestCount += 1;
      return Promise.resolve(Response.json({}));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ clerkToken: "clerk-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayUrlInvalidError",
        relayUrl: "http://relay.example.test",
        message: "Relay URL must be a secure absolute HTTPS origin.",
      });
      expect(requestCount).toBe(0);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, "http://relay.example.test")));
  });

  it.effect("reuses usable DPoP tokens and refreshes cleared or expiring cache entries", () => {
    let tokenExchangeCount = 0;
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: `relay-token-${tokenExchangeCount}`,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 10,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-05-25T00:01:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const statusInput = {
        clerkToken: clerkToken("user-1", "session-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      } as const;

      yield* relayClient.getEnvironmentStatus(statusInput);
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(1);

      yield* TestClock.adjust(Duration.seconds(6));
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(2);

      yield* relayClient.resetTokenCache;
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(3);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn)));
  });

  it.effect("reuses a persisted token across runtimes and Clerk session token rotation", () => {
    let tokenExchangeCount = 0;
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: "persisted-relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;
    const statusInput = (token: string) =>
      ({
        clerkToken: token,
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      }) as const;

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.getEnvironmentStatus(statusInput(clerkToken("user-1", "session-1")));
      }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toHaveLength(1);

      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.getEnvironmentStatus(statusInput(clerkToken("user-1", "session-2")));
      }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
    });
  });

  it.effect("refreshes a persisted DPoP token once when the relay rejects it", () => {
    let tokenExchangeCount = 0;
    const statusTokens: Array<string | null> = [];
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "client-thumbprint",
        scopes: [RelayEnvironmentStatusScope],
        accessToken: "stale-relay-token",
        expiresAtMillis: Number.MAX_SAFE_INTEGER,
      },
    ];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.sync(() => persistedTokens),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.sync(() => {
        persistedTokens = [];
      }),
    };
    const fetchFn = ((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: "fresh-relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }

      const authorization = new Headers(init?.headers).get("authorization");
      statusTokens.push(authorization);
      if (authorization === "DPoP stale-relay-token") {
        return Promise.resolve(
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace-stale-token",
            },
            { status: 401 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const result = yield* relayClient.getEnvironmentStatus({
        clerkToken: clerkToken("user-1", "session-1"),
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(result.status).toBe("online");
      expect(statusTokens).toEqual(["DPoP stale-relay-token", "DPoP fresh-relay-token"]);
      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toMatchObject([
        {
          accessToken: "fresh-relay-token",
        },
      ]);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("does not persist tokens when the Clerk subject cannot be decoded", () => {
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [];
    const accessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
      load: Effect.succeed([]),
      save: (entries) =>
        Effect.sync(() => {
          persistedTokens = entries;
        }),
      clear: Effect.void,
    };
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        return Promise.resolve(
          Response.json({
            access_token: "relay-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-06-05T20:00:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient.getEnvironmentStatus({
        clerkToken: "not-a-jwt",
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      });

      expect(persistedTokens).toEqual([]);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("times out stalled relay environment listing requests", () => {
    const fetchFn = (() =>
      new Promise<Response>(() => undefined)) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const errorFiber = yield* relayClient
        .listEnvironments({ clerkToken: "clerk-token" })
        .pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestTimeoutError",
        activity: "Relay environment listing",
        timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
        message: "Relay environment listing timed out.",
      });
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managedRelayTestLayer(fetchFn))));
  });

  it.effect("preserves typed relay trace IDs on client errors", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_bearer",
            traceId: "trace-managed-relay",
          },
          { status: 401 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ clerkToken: "clerk-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        traceId: "trace-managed-relay",
      });
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn)));
  });

  it.effect("lists account devices through the Clerk bearer client endpoint", () => {
    const fetchFn = ((input, init) => {
      expect(String(input)).toBe("https://relay.example.test/v1/client/devices");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer clerk-token",
      });
      return Promise.resolve(
        Response.json({
          devices: [
            {
              deviceId: "device-1",
              label: "Julius's iPhone",
              platform: "ios",
              iosMajorVersion: 18,
              appVersion: "1.0.0",
              notifications: {
                enabled: false,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true,
                notifyOnBlocked: true,
              },
              liveActivities: {
                enabled: true,
              },
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const devices = yield* relayClient.listDevices({ clerkToken: "clerk-token" });
      expect(devices).toMatchObject([
        {
          deviceId: "device-1",
          label: "Julius's iPhone",
          notifications: {
            enabled: false,
          },
        },
      ]);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn)));
  });
});
