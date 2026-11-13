import {
  AuthStandardClientScopes,
  EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { presentConnectionState } from "./presentation.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, entryWithRoutes, isLearned, mergeLearnedRoutes } from "./routes.ts";
import { LAN_ENTRY, LAN_ROUTE, LAN_TARGET, LAN_THEN_RELAY_ENTRY, PREPARED_CONNECTION, PROBE_CAPABLE_CONFIG, RELAY_ENTRY, RELAY_TARGET, TARGET, TARGET_ENTRY, TEST_RPC_CLIENT, awaitState, blocked, makeHarness, preparedFor, transient } from "./supervisor.helpers2.testkit.ts";

describe("EnvironmentSupervisor", () => {

  const makeSilentSocketHarness = (options?: {
    readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
    readonly checkHost?: (check: number) => ConnectionDriver.RouteCheck;
  }) =>
    Effect.gen(function* () {
      const hostChecks = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: options?.probe ?? ((attempt) => (attempt === 1 ? Effect.never : Effect.void)),
        checkHost: (prepared) =>
          Ref.updateAndGet(hostChecks, (checks) => [...checks, prepared.target._tag]).pipe(
            Effect.map((checks) => options?.checkHost?.(checks.length) ?? "answered"),
          ),
      });
      return { ...harness, hostChecks };
    });

  it.effect("checks the host afresh when the network changes after a frame", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Effect.succeed("answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1 second");
      yield* Ref.update(frames, (count) => count + 1);
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      // The running check sees the frame at 2.5 s, so a fresh one starts then.
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a running check's window when the network changes during a long resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* TestClock.adjust("1 second");
      yield* harness.wake("network-changed");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1500 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host again when one check goes unanswered", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        checkHost: (check) => (check === 1 ? "silent" : "answered"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("1499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.hostChecks)).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("leaves a web or desktop foreground probe to its own deadline", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness({
        probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("20 seconds");

      expect(yield* Ref.get(harness.hostChecks)).toEqual([]);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("checks the host when a network change arrives during a foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeSilentSocketHarness();
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("100 millis");
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("499 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps waiting for the probe when a frame arrives during the host check", () =>
    Effect.gen(function* () {
      const frames = yield* Ref.make(0);
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.sleep("2 seconds") : Effect.void),
        inboundFrames: Ref.get(frames),
        checkHost: () => Ref.update(frames, (count) => count + 1).pipe(Effect.as("answered")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("5 seconds");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("waits out a LAN resume probe when the host does not answer a fresh request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        initialConfig: () => Effect.succeed(PROBE_CAPABLE_CONFIG),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        checkHost: () => Effect.succeed("silent"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["application-active-probe", "network-changed"] as const)(
    "gives a live remote socket 15 seconds to answer a %s probe",
    (wakeup) =>
      Effect.gen(function* () {
        // A slow path delays the fresh request as much as the probe.
        const harness = yield* makeSilentSocketHarness({
          probe: (attempt) => (attempt === 1 ? Effect.sleep("4 seconds") : Effect.void),
          checkHost: () => "silent",
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        yield* harness.wake(wakeup);
        yield* TestClock.adjust("20 seconds");

        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces an unanswered long resume probe even while the network reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-long");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);

      yield* TestClock.adjust("1 millis");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.lastFailure).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the session closes during a resume probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(probeStarted);
      yield* harness.closeLatestSession();

      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting",
      );
      expect(reconnecting.attempt).toBe(1);
      expect(reconnecting.lastFailure).toBeNull();
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(preparedFor(RELAY_TARGET)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("refreshes HTTP authorization without replacing the active relay session", () =>
    Effect.gen(function* () {
      const endpoint = {
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
        providerKind: "cloudflare_tunnel" as const,
      };
      const token = yield* Ref.make(
        Option.some(
          new TokenStore.RemoteDpopAccessToken({
            environmentId: TARGET.environmentId,
            accountId: "test-account",
            label: TARGET.label,
            endpoint,
            accessToken: "access-token-1",
            expiresAtEpochMs: 3_600_000,
            dpopThumbprint: "test-thumbprint",
          }),
        ),
      );
      const bootstrapFails = yield* Ref.make(false);
      const bootstrapCalls = yield* Ref.make(0);
      const httpPaths: Array<string> = [];
      const sessionAuthorizations: Array<string | null> = [];
      const fetchFn = ((input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        httpPaths.push(pathname);
        switch (pathname) {
          case "/.well-known/t3/environment":
            return Promise.resolve(
              Response.json({
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          case "/oauth/token":
            return Promise.resolve(
              Response.json({
                access_token: "access-token-2",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3_600,
                scope: AuthStandardClientScopes.join(" "),
              }),
            );
          case "/api/auth/websocket-ticket/rpc":
            return Promise.resolve(
              Response.json({
                ticket: "ws-ticket",
                expiresAt: "2026-09-04T01:00:00.000Z",
              }),
            );
          case "/api/auth/session": {
            const authorization = request.headers.get("authorization");
            sessionAuthorizations.push(authorization);
            return Promise.resolve(
              Response.json({
                authenticated: authorization === "DPoP access-token-2",
                auth: {
                  policy: "loopback-browser",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["dpop-access-token"],
                  sessionCookieName: "t3_session_test",
                },
                scopes: AuthStandardClientScopes,
              }),
            );
          }
          default:
            return Promise.reject(new Error(`Unexpected HTTP request to ${request.url}`));
        }
      }) satisfies typeof fetch;
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("test-proof"),
      });
      const unused = () => Effect.die("Unexpected relay operation.");
      const relay = ManagedRelay.ManagedRelayClient.of({
        relayUrl: "https://relay.example.test",
        listEnvironments: unused,
        listDevices: unused,
        createEnvironmentLinkChallenge: unused,
        linkEnvironment: unused,
        unlinkEnvironment: unused,
        getT3ChatLink: unused,
        createT3ChatLinkRequest: unused,
        unlinkT3Chat: unused,
        getEnvironmentStatus: unused,
        connectEnvironment: Effect.fn("TestConnectionHttp.connectEnvironment")(function* () {
          yield* Ref.update(bootstrapCalls, (count) => count + 1);
          if (yield* Ref.get(bootstrapFails)) {
            return yield* new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: 6_000,
              traceId: null,
            });
          }
          return {
            environmentId: TARGET.environmentId,
            endpoint,
            credential: "relay-bootstrap",
            expiresAt: "2026-09-04T01:00:00.000Z",
          };
        }),
        registerDevice: unused,
        unregisterDevice: unused,
        registerLiveActivity: unused,
        getAgentActivitySnapshot: unused,
        resetTokenCache: Effect.void,
      });
      const layerHttp = RpcHttp.layerRemoteHttpClient(fetchFn);
      const remoteAuthorization = yield* RemoteEnvironmentAuthorization.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerHttp,
            Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
            Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
            Layer.succeed(ClientCapabilities.CloudSession, {
              identity: Effect.succeedSome({ accountId: "test-account" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
            Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
              deviceId: Effect.succeedNone,
            }),
            Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
              get: () => Ref.get(token),
              put: (value) => Ref.set(token, Option.some(value)),
              remove: () => Ref.set(token, Option.none()),
            }),
            Layer.succeed(ClientCapabilities.ClientPresentation, {
              metadata: { label: "Test client", deviceType: "desktop" },
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({
        prepare: () =>
          remoteAuthorization
            .authorizeDpop({ expectedEnvironmentId: TARGET.environmentId })
            .pipe(Effect.map((prepared) => ({ ...prepared, target: RELAY_TARGET }))),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      const readSession = fetchEnvironmentSessionState({
        prepared,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(layerHttp));

      yield* TestClock.adjust("2 hours");
      expect((yield* readSession).authenticated).toBe(true);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(yield* Ref.get(bootstrapCalls)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("2 hours");
      yield* Ref.set(bootstrapFails, true);
      const failure = yield* readSession.pipe(Effect.flip);
      expect(failure._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(yield* Ref.get(bootstrapCalls)).toBe(2);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(httpPaths.filter((path) => path === "/api/auth/websocket-ticket/rpc")).toHaveLength(1);
      expect(httpPaths.filter((path) => path === "/oauth/token")).toHaveLength(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});
