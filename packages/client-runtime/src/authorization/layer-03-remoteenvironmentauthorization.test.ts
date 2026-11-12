import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { type RelayEnvironmentConnectResponse } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import * as ConnectionProfileStore from "../connection/profileStore.ts";
import * as ConnectionResolver from "../connection/resolver.ts";

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

type RecordedResponse = Response | ((init: RequestInit) => Response);

function recordedFetch(responses: ReadonlyArray<RecordedResponse>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(typeof response === "function" ? response(init ?? {}) : response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

const accessToken = (token: string, scope = AuthStandardClientScopes.join(" ")) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope,
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
  readonly responses: ReadonlyArray<RecordedResponse>;
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
    getT3ChatLink: unexpected,
    createT3ChatLinkRequest: unexpected,
    unlinkT3Chat: unexpected,
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
    Layer.provideMerge(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Ref.get(session),
          clerkToken: input.clerkToken ?? Effect.succeed("clerk-session"),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeedSome("device-1"),
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

const prepareDirectBearer = Effect.fn("TestRemoteAuthorization.prepareDirectBearer")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  times: number,
) {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: DESCRIPTOR.label,
    connectionId: "direct-1",
  });
  const entry = {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      }),
    ),
    enabled: true,
  };
  const unused = () => Effect.die("unused");
  const layer = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, {
          get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "bearer-token" })),
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
          provision: unused,
          prepare: unused,
          disconnect: unused,
        }),
      ),
    ),
  );
  const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layer));
  return yield* Effect.forEach(Array.from({ length: times }), () =>
    resolver.prepare(entry).pipe(Effect.result),
  );
});



describe("RemoteEnvironmentAuthorization", () => {
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
});

