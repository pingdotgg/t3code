import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  type RelayEnvironmentConnectResponse,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { DPOP_UNKNOWN_HINT } from "../relay/errorPresentation.ts";
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
const BOOTSTRAP: RelayEnvironmentConnectResponse = {
  environmentId: ENVIRONMENT_ID,
  endpoint: ENDPOINT,
  credential: "relay-bootstrap",
  expiresAt: "2026-06-06T01:00:00.000Z",
};

function recordedFetch(responses: ReadonlyArray<Response>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
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

const persistedToken = (
  input: {
    readonly environmentId?: EnvironmentId;
    readonly accessToken?: string;
    readonly expiresAtEpochMs?: number;
    readonly dpopThumbprint?: string;
  } = {},
) =>
  new TokenStore.RemoteDpopAccessToken({
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    accountId: "account-1",
    label: DESCRIPTOR.label,
    endpoint: ENDPOINT,
    accessToken: input.accessToken ?? "cached-access-token",
    expiresAtEpochMs: input.expiresAtEpochMs ?? Number.MAX_SAFE_INTEGER,
    dpopThumbprint: input.dpopThumbprint ?? "thumbprint-1",
  });

const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly initialToken?: TokenStore.RemoteDpopAccessToken;
  readonly responses: ReadonlyArray<Response>;
  readonly bootstrap?: RelayEnvironmentConnectResponse;
  readonly beforeBootstrap?: Effect.Effect<void, ManagedRelay.ManagedRelayClientError>;
  readonly beforePut?: Effect.Effect<void>;
  readonly clerkToken?: ClientCapabilities.CloudSession["Service"]["clerkToken"];
}) {
  const tokens = yield* Ref.make(
    new Map(
      input.initialToken === undefined
        ? []
        : [[input.initialToken.environmentId, input.initialToken]],
    ),
  );
  const bootstrapCalls = yield* Ref.make(0);
  const relayInputs = yield* Ref.make<
    ReadonlyArray<Parameters<ManagedRelay.ManagedRelayClient["Service"]["connectEnvironment"]>[0]>
  >([]);
  const session = yield* Ref.make<Option.Option<ClientCapabilities.CloudSessionIdentity>>(
    Option.some({ accountId: "account-1" }),
  );
  const thumbprint = yield* Ref.make("thumbprint-1");
  const tokenReads = yield* Queue.unbounded<EnvironmentId>();
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
        Effect.tap(() => Queue.offer(tokenReads, environmentId)),
      ),
    put: (token) =>
      (input.beforePut ?? Effect.void).pipe(
        Effect.andThen(
          Ref.update(tokens, (current) => {
            const next = new Map(current);
            next.set(token.environmentId, token);
            return next;
          }),
        ),
      ),
    remove: (environmentId) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Ref.get(thumbprint),
    createProof: (proofInput) =>
      Ref.update(proofInputs, (current) => [...current, proofInput]).pipe(
        Effect.as(`proof:${proofInput.url}`),
      ),
  });
  const unexpected = () => Effect.die("Unexpected relay request");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: unexpected,
    listDevices: unexpected,
    createEnvironmentLinkChallenge: unexpected,
    linkEnvironment: unexpected,
    unlinkEnvironment: unexpected,
    getEnvironmentStatus: unexpected,
    connectEnvironment: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(bootstrapCalls, (count) => count + 1);
        yield* Ref.update(relayInputs, (current) => [...current, request]);
        yield* input.beforeBootstrap ?? Effect.void;
        return input.bootstrap ?? BOOTSTRAP;
      }),
    registerDevice: unexpected,
    unregisterDevice: unexpected,
    registerLiveActivity: unexpected,
    getAgentActivitySnapshot: unexpected,
    resetTokenCache: Effect.void,
  });
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Ref.get(session),
          clerkToken: input.clerkToken ?? Effect.succeed("clerk-session"),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeed(Option.some("device-1")),
        }),
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
  return {
    layer,
    tokens,
    bootstrapCalls,
    proofInputs,
    fetch,
    relayInputs,
    session,
    thumbprint,
    tokenReads,
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
            connectionMethod: "direct",
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

  it.effect("revalidates a bearer descriptor after the cache expires", () =>
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
            connectionMethod: "direct",
          });

        yield* authorize();
        yield* TestClock.adjust("10 seconds");
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
    }),
  );

  it.effect("reuses a same-account persisted environment token without contacting the relay", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
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
        });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized.socketUrl).toContain("wsTicket=cached-ticket");
      expect(authorized.socketUrl).toContain("connectionMethod=relay");
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
        accountId: "account-1",
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
        accountId: "account-1",
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

  it.effect("presents clock skew as one possible cause for a generic DPoP rejection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [Response.json(DESCRIPTOR), authInvalid()],
      });

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpop({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect(failure).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        detail: `The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`,
        traceId: "trace-auth-invalid",
      });
    }),
  );

  it.effect("refreshes a cached endpoint after its first transient failure", () =>
    Effect.gen(function* () {
      const cached = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        accountId: "account-1",
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

  it.effect("removes a newly refreshed token when websocket ticket authorization fails", () =>
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
        });
      }).pipe(Effect.provide(harness.layer), Effect.flip);

      expect((yield* Ref.get(harness.tokens)).has(ENVIRONMENT_ID)).toBe(false);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(3);
    }),
  );

  it.effect("uses the current cached HTTP token without a relay request or websocket ticket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ initialToken: persistedToken(), responses: [] });
      const authorized = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
      }).pipe(Effect.provide(harness.layer));

      expect(authorized).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "cached-access-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        },
      });
      expect(harness.fetch.calls).toHaveLength(0);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
      expect(yield* Ref.get(harness.proofInputs)).toEqual([]);
    }),
  );

  it.effect(
    "renews HTTP credentials near expiry through the current cloud account and device",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const harness = yield* makeHarness({
          initialToken: persistedToken({ expiresAtEpochMs: now + 61_000 }),
          responses: [Response.json(DESCRIPTOR), accessToken("fresh-access-token")],
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const before = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
          expect(before.httpAuthorization.accessToken).toBe("cached-access-token");
          yield* TestClock.adjust("1 second");
          const after = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
          expect(after.httpAuthorization.accessToken).toBe("fresh-access-token");
          expect(after.httpAuthorization.expiresAtEpochMs).toBe(now + 3_601_000);
        }).pipe(Effect.provide(harness.layer));

        expect(yield* Ref.get(harness.relayInputs)).toEqual([
          {
            environmentId: ENVIRONMENT_ID,
            clerkToken: "clerk-session",
            scopes: [RelayEnvironmentConnectScope],
            deviceId: "device-1",
          },
        ]);
        expect(harness.fetch.calls.map(([url]) => String(url))).toEqual([
          `${ENDPOINT.httpBaseUrl}/.well-known/t3/environment`,
          `${ENDPOINT.httpBaseUrl}/oauth/token`,
        ]);
        expect(yield* Ref.get(harness.proofInputs)).toEqual([
          {
            method: "POST",
            url: `${ENDPOINT.httpBaseUrl}/oauth/token`,
          },
        ]);
      }),
  );

  it.effect("does not evict a replacement token when a late request rejects the old one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("replacement-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const initial = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        const retry = {
          expectedEnvironmentId: ENVIRONMENT_ID,
          rejectedAccessToken: initial.httpAuthorization.accessToken,
        };
        const first = yield* remote.authorizeDpopHttp(retry);
        const late = yield* remote.authorizeDpopHttp(retry);
        expect(first.httpAuthorization.accessToken).toBe("replacement-token");
        expect(late).toEqual(first);
      }).pipe(Effect.provide(harness.layer));

      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accessToken).toBe(
        "replacement-token",
      );
    }),
  );

  it.effect("shares one in-flight renewal between concurrent HTTP requests", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        initialToken: persistedToken({ expiresAtEpochMs: 0 }),
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("shared-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const requests = yield* Effect.all(
          Array.from({ length: 6 }, () =>
            remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Queue.takeN(harness.tokenReads, 6);
        yield* Deferred.await(started);
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(requests);
        expect(results.map((result) => result.httpAuthorization.accessToken)).toEqual(
          Array(6).fill("shared-token"),
        );
      }).pipe(Effect.provide(harness.layer));

      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
    }),
  );

  it.effect(
    "shares a failed renewal and allows a later attempt instead of caching its failure",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void, ManagedRelay.ManagedRelayClientError>();
        const failure = new ManagedRelay.ManagedRelayRequestTimeoutError({
          activity: "Relay environment connection",
          timeoutMs: ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS,
          traceId: null,
        });
        const harness = yield* makeHarness({
          responses: [],
          beforeBootstrap: Deferred.await(release),
        });
        yield* Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          const requests = yield* Effect.all(
            Array.from({ length: 6 }, () =>
              remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID }).pipe(Effect.flip),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Queue.takeN(harness.tokenReads, 6);
          yield* Deferred.fail(release, failure);
          const failures = yield* Fiber.join(requests);
          expect(failures).toEqual(
            Array(6).fill(
              expect.objectContaining({
                _tag: "ConnectionTransientError",
                reason: "timeout",
              }),
            ),
          );
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
          yield* remote
            .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
            .pipe(Effect.flip);
          expect(yield* Ref.get(harness.bootstrapCalls)).toBe(2);
        }).pipe(Effect.provide(harness.layer));
        expect(harness.fetch.calls).toHaveLength(0);
      }),
  );

  it.effect("does not block another environment behind a pending renewal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      const harness = yield* makeHarness({
        initialToken: persistedToken({
          environmentId: otherEnvironmentId,
          accessToken: "other-token",
        }),
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("fresh-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const other = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: otherEnvironmentId,
        });
        expect(other.httpAuthorization.accessToken).toBe("other-token");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not return or persist credentials after logout during renewal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Ref.set(harness.session, Option.none());
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).size).toBe(0);
      expect(harness.fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("removes an obsolete credential if logout overlaps the persistent write", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforePut: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("obsolete-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Ref.set(harness.session, Option.none());
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).size).toBe(0);
    }),
  );

  it.effect(
    "renews another account's persisted token after the authorization service restarts",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          initialToken: persistedToken(),
          responses: [Response.json(DESCRIPTOR), accessToken("account-2-token")],
        });
        const authorize = Effect.gen(function* () {
          const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
          return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        }).pipe(Effect.provide(harness.layer));

        expect((yield* authorize).httpAuthorization.accessToken).toBe("cached-access-token");
        yield* Ref.set(harness.session, Option.some({ accountId: "account-2" }));
        expect((yield* authorize).httpAuthorization.accessToken).toBe("account-2-token");
        expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accountId).toBe("account-2");

        yield* Ref.set(harness.session, Option.some({ accountId: "account-2" }));
        expect((yield* authorize).httpAuthorization.accessToken).toBe("account-2-token");
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        expect(harness.fetch.calls).toHaveLength(2);
      }),
  );

  it.effect("renews a legacy unowned token once and reuses its account-bound replacement", () =>
    Effect.gen(function* () {
      const legacy = new TokenStore.RemoteDpopAccessToken({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        endpoint: ENDPOINT,
        accessToken: "legacy-access-token",
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        dpopThumbprint: "thumbprint-1",
      });
      const harness = yield* makeHarness({
        initialToken: legacy,
        responses: [Response.json(DESCRIPTOR), accessToken("account-bound-token")],
      });
      const authorize = Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
      }).pipe(Effect.provide(harness.layer));

      expect((yield* authorize).httpAuthorization.accessToken).toBe("account-bound-token");
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.accountId).toBe("account-1");
      expect((yield* authorize).httpAuthorization.accessToken).toBe("account-bound-token");
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
      expect(harness.fetch.calls).toHaveLength(2);
    }),
  );

  it.effect("requires fresh credentials after signing back into the same account", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("new-session-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        yield* Ref.set(harness.session, Option.none());
        const signedOut = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip);
        expect(signedOut).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "authentication",
        });
        yield* Ref.set(harness.session, Option.some({ accountId: "account-1" }));
        const signedIn = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        expect(signedIn.httpAuthorization.accessToken).toBe("new-session-token");
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );

  it.effect("renews a cached credential bound to a different signing key", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [Response.json(DESCRIPTOR), accessToken("new-key-token")],
      });
      yield* Ref.set(harness.thumbprint, "thumbprint-2");
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorized = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
        expect(authorized.httpAuthorization.accessToken).toBe("new-key-token");
      }).pipe(Effect.provide(harness.layer));
      expect((yield* Ref.get(harness.tokens)).get(ENVIRONMENT_ID)?.dpopThumbprint).toBe(
        "thumbprint-2",
      );
    }),
  );

  it.effect("rejects a relay bootstrap for a different environment before contacting it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        responses: [],
        bootstrap: { ...BOOTSTRAP, environmentId: EnvironmentId.make("wrong-environment") },
      });
      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        return yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
      }).pipe(Effect.provide(harness.layer), Effect.flip);
      expect(failure).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(harness.fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("keeps a shared renewal alive when one waiting request is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        beforeBootstrap: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        responses: [Response.json(DESCRIPTOR), accessToken("fresh-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const other = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.forkChild);
        yield* Queue.takeN(harness.tokenReads, 2);
        yield* Fiber.interrupt(pending);
        yield* Deferred.succeed(release, undefined);
        const authorized = yield* Fiber.join(other);
        expect(authorized.httpAuthorization.accessToken).toBe("fresh-token");
        const cached = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID });
        expect(cached).toEqual(authorized);
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );

  it.effect("times out a stalled cloud token read so later requests can renew again", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reads = yield* Ref.make(0);
      const harness = yield* makeHarness({
        clerkToken: Effect.gen(function* () {
          const read = yield* Ref.updateAndGet(reads, (value) => value + 1);
          if (read === 1) {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }
          return "clerk-session";
        }),
        responses: [Response.json(DESCRIPTOR), accessToken("fresh-token")],
      });
      yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const pending = yield* remote
          .authorizeDpopHttp({ expectedEnvironmentId: ENVIRONMENT_ID })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "ConnectionTransientError",
          reason: "timeout",
        });
        const authorized = yield* remote.authorizeDpopHttp({
          expectedEnvironmentId: ENVIRONMENT_ID,
        });
        expect(authorized.httpAuthorization.accessToken).toBe("fresh-token");
      }).pipe(Effect.provide(harness.layer));
      expect(yield* Ref.get(reads)).toBe(2);
      expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
    }),
  );
});
