import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { RELAY_GATEWAY_TIMEOUT_MESSAGE, relayRequestFailureDetail } from "./errorPresentation.ts";
import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

function layerManagedRelayTest(
  fetchFn: typeof globalThis.fetch,
  relayUrl = "https://relay.example.test",
  accessTokenStore?: ManagedRelay.ManagedRelayAccessTokenStore,
) {
  const layerHttpClient = RpcHttp.layerRemoteHttpClient(fetchFn);
  const layerSigner = Layer.succeed(
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
  }).pipe(Layer.provide(layerSigner), Layer.provide(layerHttpClient));
}

function clerkToken(subject: string, nonce: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${encode({ alg: "none" })}.${encode({ sub: subject, nonce })}.signature`;
}

describe("ManagedRelayClient", () => {
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
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, "http://relay.example.test")));
  });

  it.effect("uses a cached token while another scope waits for an exchange", () => {
    const exchangeStarted = Promise.withResolvers<void>();
    const releaseExchange = Promise.withResolvers<void>();
    let tokenExchangeCount = 0;
    const statusTokens: Array<string | null> = [];
    let persistedTokens: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry> = [
      {
        accountId: "user-1",
        clientId: "t3-mobile",
        relayUrl: "https://relay.example.test",
        thumbprint: "client-thumbprint",
        scopes: [RelayEnvironmentStatusScope],
        accessToken: "cached-status-token",
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
      if (String(input).endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        exchangeStarted.resolve();
        return releaseExchange.promise.then(() =>
          Response.json({
            access_token: "expanded-scope-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 1_800,
            scope: `${RelayEnvironmentStatusScope} ${RelayEnvironmentConnectScope}`,
          }),
        );
      }
      statusTokens.push(new Headers(init?.headers).get("authorization"));
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-09-04T00:00:00.000Z",
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
      const expandedScopeInput = {
        ...statusInput,
        scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
      } as const;
      const firstMiss = yield* relayClient
        .getEnvironmentStatus(expandedScopeInput)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => exchangeStarted.promise);
      const secondMiss = yield* relayClient
        .getEnvironmentStatus(expandedScopeInput)
        .pipe(Effect.forkChild);

      const status = yield* relayClient.getEnvironmentStatus(statusInput);
      expect(status.status).toBe("online");
      expect(statusTokens).toEqual(["DPoP cached-status-token"]);

      releaseExchange.resolve();
      yield* Fiber.join(firstMiss);
      yield* Fiber.join(secondMiss);
      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens.map((token) => token.accessToken)).toEqual([
        "cached-status-token",
        "expanded-scope-token",
      ]);
      yield* relayClient.resetTokenCache;
      expect(persistedTokens).toEqual([]);
      yield* relayClient.getEnvironmentStatus(expandedScopeInput);
      expect(tokenExchangeCount).toBe(2);
    }).pipe(
      Effect.ensuring(Effect.sync(() => releaseExchange.resolve())),
      Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)),
    );
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
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

      expect(tokenExchangeCount).toBe(1);
      expect(persistedTokens).toHaveLength(1);

      yield* Effect.gen(function* () {
        const relayClient = yield* ManagedRelay.ManagedRelayClient;
        yield* relayClient.getEnvironmentStatus(statusInput(clerkToken("user-1", "session-2")));
      }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));

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
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));
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
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn, undefined, accessTokenStore)));
  });

  it.effect("explains a relay deadline 504 on link and keeps its trace ID", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          { error: "relay_request_deadline_exceeded" },
          {
            status: 504,
            headers: {
              traceparent: "00-4684d7d140f34f0393d42744d240e207-0baf648c44f4bce6-01",
            },
          },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .linkEnvironment({
          clerkToken: "clerk-token",
          payload: {
            proof: "link-proof",
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        status: 504,
        traceId: "4684d7d140f34f0393d42744d240e207",
      });
      expect(
        error._tag === "ManagedRelayRequestFailedError" ? relayRequestFailureDetail(error) : null,
      ).toBe(RELAY_GATEWAY_TIMEOUT_MESSAGE);
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it.effect("names the relay's reason when unlinking fails and keeps its trace ID", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayInternalError",
            code: "internal_error",
            reason: "upstream_unavailable",
            traceId: "trace-unlink",
          },
          { status: 500 },
        ),
      )) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const error = yield* relayClient
        .unlinkEnvironment({
          clerkToken: "clerk-token",
          environmentId: EnvironmentId.make("env-1"),
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        traceId: "trace-unlink",
        relayError: { _tag: "RelayInternalError", reason: "upstream_unavailable" },
      });
      expect(error.message).toBe(
        "Could not unlink relay environment: Relay encountered an internal error (upstream_unavailable).",
      );
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });

  it("keeps an undeclared relay status and the network hint in the message", () => {
    expect(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "unlink relay environment",
        cause: new Error("Bad Gateway"),
        status: 502,
      }).message,
    ).toBe("Could not unlink relay environment: Relay returned an unexpected HTTP 502.");
    expect(
      new ManagedRelay.ManagedRelayRequestFailedError({
        action: "unlink relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }).message,
    ).toBe(`Could not unlink relay environment. ${NETWORK_BLOCKING_HINT}`);
  });

  it.effect("accepts generic DPoP errors from relays without the optional reason", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json(
          {
            _tag: "RelayAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_dpop",
            traceId: "trace-old-relay",
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
        traceId: "trace-old-relay",
        relayError: {
          _tag: "RelayAuthInvalidError",
          reason: "invalid_dpop",
        },
      });
      if (
        error._tag === "ManagedRelayRequestFailedError" &&
        error.relayError?._tag === "RelayAuthInvalidError"
      ) {
        expect(error.relayError.dpopFailureReason).toBeUndefined();
      }
    }).pipe(Effect.provide(layerManagedRelayTest(fetchFn)));
  });
});
