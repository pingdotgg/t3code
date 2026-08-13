import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const BOOTSTRAP: RemoteEnvironmentAuthorization.RelayEnvironmentAuthorization = {
  environmentId: ENVIRONMENT_ID,
  endpoint: ENDPOINT,
  credential: "relay-bootstrap",
};

function recordedFetch(responses: ReadonlyArray<Response | Error | Promise<Response>>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (response instanceof Error) return Promise.reject(response);
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const accessToken = (token: string) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope: AuthStandardClientScopes.join(" "),
  });

const authInvalid = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-auth-invalid",
    },
    { status: 401 },
  );

const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly initialToken?: TokenStore.RemoteDpopAccessToken;
  readonly responses: ReadonlyArray<Response | Error | Promise<Response>>;
}) {
  const tokens = yield* Ref.make(
    new Map(
      input.initialToken === undefined
        ? []
        : [[input.initialToken.environmentId, input.initialToken]],
    ),
  );
  const bootstrapCalls = yield* Ref.make(0);
  const proofInputs = yield* Ref.make<
    ReadonlyArray<{
      readonly method: string;
      readonly url: string;
      readonly accessToken?: string;
    }>
  >([]);
  const fetch = recordedFetch(input.responses);

  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(tokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
      ),
    put: (token) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.set(token.environmentId, token);
        return next;
      }),
    remove: (environmentId) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint-1"),
    createProof: (proofInput) =>
      Ref.update(proofInputs, (current) => [...current, proofInput]).pipe(
        Effect.as(`proof:${proofInput.url}`),
      ),
  });
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: {
              label: "T3 Code Test",
              deviceType: "mobile",
              os: "test",
            },
            scopes: AuthStandardClientScopes,
          }),
        ),
      ),
    ),
  );
  const obtainBootstrap = Ref.update(bootstrapCalls, (count) => count + 1).pipe(
    Effect.as(BOOTSTRAP),
  );

  return {
    layer,
    tokens,
    bootstrapCalls,
    proofInputs,
    fetch,
    obtainBootstrap,
  };
});

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("reuses a validated bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          websocketTicket("second-ticket"),
        ],
      });

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(1);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(2);
    }),
  );

  it.effect("rejects a mismatched port owner before sending it a bearer credential", () =>
    Effect.gen(function* () {
      const reassignedEnvironmentId = EnvironmentId.make("environment-2");
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json({
            ...DESCRIPTOR,
            environmentId: reassignedEnvironmentId,
          }),
        ],
      });

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
            requestTimeoutMs: 3_000,
            transportRetries: 1,
            requireFreshDescriptor: true,
          });

        yield* authorize();
        return yield* authorize().pipe(Effect.flip);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(failure).toEqual(
        expect.objectContaining({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
          detail: `Connected environment ${reassignedEnvironmentId} does not match ${ENVIRONMENT_ID}.`,
        }),
      );
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(2);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(1);
    }),
  );

  it.effect("retries a live descriptor without sending the stale port owner a bearer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          new Error("replacement backend not accepting requests yet"),
          Response.json(DESCRIPTOR),
          websocketTicket("reconnect-ticket"),
        ],
      });

      const reconnect = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "desktop-bearer",
            requestTimeoutMs: 3_000,
            transportRetries: 1,
            requireFreshDescriptor: true,
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        const reconnectFiber = yield* Effect.forkChild(authorize());
        yield* Effect.yieldNow;
        yield* TestClock.adjust("249 millis");
        expect(reconnectFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(reconnectFiber);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(reconnect.socketUrl).toContain("wsTicket=reconnect-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(3);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(2);
    }),
  );

  it.effect("revalidates and retries a hung ticket during the descriptor cache window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          Response.json(DESCRIPTOR),
          new Promise<Response>(() => {}),
          Response.json(DESCRIPTOR),
          websocketTicket("reconnect-ticket"),
        ],
      });

      const reconnect = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "desktop-bearer",
            requestTimeoutMs: 3_000,
            transportRetries: 1,
            requireFreshDescriptor: true,
          });
        yield* authorize();
        const reconnectFiber = yield* Effect.forkChild(authorize());
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("250 millis");
        return yield* Fiber.join(reconnectFiber);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(reconnect.socketUrl).toContain("wsTicket=reconnect-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(3);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(3);
    }),
  );

  it.effect("reprobes after a hung dead listener without disclosing the bearer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          new Promise<Response>(() => {}),
          Response.json(DESCRIPTOR),
          websocketTicket("reconnect-ticket"),
        ],
      });

      const reconnect = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "desktop-bearer",
            requestTimeoutMs: 3_000,
            transportRetries: 1,
            requireFreshDescriptor: true,
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        const reconnectFiber = yield* Effect.forkChild(authorize());
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("250 millis");
        return yield* Fiber.join(reconnectFiber);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(reconnect.socketUrl).toContain("wsTicket=reconnect-ticket");
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(3);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(2);
    }),
  );

  it.effect("ends the attempt without sending a bearer when both descriptor probes hang", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          new Promise<Response>(() => {}),
          new Promise<Response>(() => {}),
        ],
      });

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "desktop-bearer",
            requestTimeoutMs: 3_000,
            transportRetries: 1,
            requireFreshDescriptor: true,
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        const reconnectFiber = yield* Effect.forkChild(Effect.flip(authorize()));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("250 millis");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        return yield* Fiber.join(reconnectFiber);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(failure).toMatchObject({ _tag: "ConnectionTransientError", reason: "timeout" });
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(3);
      expect(
        harness.fetch.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(1);
    }),
  );

  it.effect("bounds a hung initial desktop descriptor probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [new Promise<Response>(() => {})],
      });

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = remote.authorizeBearer({
          expectedEnvironmentId: ENVIRONMENT_ID,
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          wsBaseUrl: ENDPOINT.wsBaseUrl,
          bearerToken: "desktop-bearer",
          requestTimeoutMs: 3_000,
        });
        const authorizeFiber = yield* Effect.forkChild(Effect.flip(authorize));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        return yield* Fiber.join(authorizeFiber);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(failure).toMatchObject({ _tag: "ConnectionTransientError", reason: "timeout" });
    }),
  );

  it.effect("does not mask response failures or reuse a descriptor for another endpoint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          authInvalid(),
          new Error("different endpoint unavailable"),
        ],
      });

      const [authenticationFailure, endpointFailure] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = (httpBaseUrl = ENDPOINT.httpBaseUrl) =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "desktop-bearer",
            requestTimeoutMs: 3_000,
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        const authenticationFailure = yield* authorize().pipe(Effect.flip);
        const endpointFailure = yield* authorize("https://replacement.example.test").pipe(
          Effect.flip,
        );
        return [authenticationFailure, endpointFailure] as const;
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(authenticationFailure).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "remote-unavailable",
      });
      expect(endpointFailure).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "network",
      });
    }),
  );

  it.effect("never reuses an expired descriptor for saved bearer connections", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          websocketTicket("first-ticket"),
          new Error("remote unavailable"),
        ],
      });

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "saved-bearer",
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        return yield* authorize().pipe(Effect.flip);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(failure).toMatchObject({ _tag: "ConnectionTransientError" });
    }),
  );

  it.effect("reuses a valid persisted environment token without contacting the relay", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [websocketTicket("cached-ticket")],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=cached-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect(harness.fetch.calls).toHaveLength(1);
      expect(String(harness.fetch.calls[0]?.[0])).toBe(
        "https://environment.example.test/api/auth/websocket-ticket",
      );
    }),
  );

  it.effect("refreshes and persists an expired environment token", () =>
    Effect.gen(function* () {
      const expired = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "expired-access-token",
        expiresAtEpochMs: 0,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: expired,
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("fresh-access-token"),
          websocketTicket("fresh-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=fresh-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "fresh-access-token",
          dpopThumbprint: "thumbprint-1",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );

  it.effect("evicts an auth-invalid cached token and obtains a fresh bootstrap", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "invalid-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [
          authInvalid(),
          Response.json(DESCRIPTOR),
          accessToken("replacement-access-token"),
          websocketTicket("replacement-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "replacement-access-token",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(4);
    }),
  );

  it.effect("refreshes a cached endpoint after its first transient failure", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "cached-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: cached,
        responses: [
          new Response("endpoint unavailable", { status: 503 }),
          Response.json(DESCRIPTOR),
          accessToken("replacement-access-token"),
          websocketTicket("replacement-ticket"),
        ],
      });

      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=replacement-ticket");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)).toEqual(
        expect.objectContaining({
          accessToken: "replacement-access-token",
        }),
      );
      expect(harness.fetch.calls).toHaveLength(4);
    }),
  );

  it.effect("does not persist a refreshed token until its websocket ticket succeeds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [
          Response.json(DESCRIPTOR),
          accessToken("unusable-access-token"),
          new Response("endpoint unavailable", { status: 503 }),
        ],
      });

      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
          obtainBootstrap: harness.obtainBootstrap,
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect((yield* Ref.get(harness.tokens)).has(ENVIRONMENT_ID)).toBe(false);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );
});
