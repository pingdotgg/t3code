import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  TAILCAT_CONNECTION_CODE_DEFAULT_TTL_SECONDS,
  TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT,
  type TailcatAddress,
  type TailcatNodeKey,
  type TailcatRemoteAccessState,
  type TailcatRuntimeInfo,
  TailcatTrustedPeer,
} from "@t3tools/contracts";
import { decodeTailcatConnectionCode } from "@t3tools/shared/t3ConnectionCode";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TailcatRemoteAccess from "./TailcatRemoteAccess.ts";

// Captured from a real `tailcat serve` run; decodes to server key 7ea7…ff32.
const SERVER_ADDRESS: TailcatAddress =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";
const SERVER_FINGERPRINT = "7ea7·7163·ff32";
const PEER_NODE_KEY: TailcatNodeKey =
  "nodekey:9ab555a4a588b75d2054adb683db82461bb6c707d43e8ba39439f8eb1e821503";
const LOCAL_PORT = 3773;
/** Mirrors the service's relock debounce: one adjust lets a pending reconcile run. */
const RELOCK_DEBOUNCE = Duration.millis(1_500);
/** Ceiling of the first-failure restart backoff (1s base plus 25% jitter). */
const FIRST_RETRY_BACKOFF_MAX = Duration.millis(1_250);
const RUNTIME_INFO: TailcatRuntimeInfo = {
  executablePath: "/opt/t3/bin/tailcat",
  source: "bundled",
  version: "0.4.2",
  pinnedVersion: "0.4.2",
  compatible: true,
};
const ENVIRONMENT_ID = EnvironmentId.make("environment-tailcat-test");
const DESCRIPTOR: ExecutionEnvironmentDescriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "Tailcat test environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

interface FakeServe {
  readonly options: {
    readonly keyPath: string;
    readonly localPort: number;
    readonly allow: TailcatRuntime.TailcatAllowPolicy;
  };
  /** Complete this to simulate the listener process dying. */
  readonly exit: Deferred.Deferred<Option.Option<number>>;
  /** False once the owning scope closed, i.e. the service stopped this listener. */
  readonly isRunning: Effect.Effect<boolean>;
}

/** Records what the service asked of the tailcat runtime; `Queue.take` is the receipt for a (re)started listener. */
class FakeTailcat extends Context.Service<
  FakeTailcat,
  {
    readonly serves: Queue.Queue<FakeServe>;
    readonly identityGenerations: Ref.Ref<number>;
  }
>()("t3/tailcat/TailcatRemoteAccess.test/FakeTailcat") {
  static readonly layer = Layer.effect(
    FakeTailcat,
    Effect.gen(function* () {
      return FakeTailcat.of({
        serves: yield* Queue.unbounded<FakeServe>(),
        identityGenerations: yield* Ref.make(0),
      });
    }),
  );
}

const fakeRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fake = yield* FakeTailcat;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let nextPid = 40_000;
    return Layer.mock(TailcatRuntime.TailcatRuntime)({
      resolve: Effect.succeed(RUNTIME_INFO),
      refresh: Effect.succeed(RUNTIME_INFO),
      generateServerIdentity: ({ keyPath }) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(keyPath), { recursive: true });
          yield* fileSystem.writeFileString(keyPath, "fake tailcat identity");
          yield* Ref.update(fake.identityGenerations, (count) => count + 1);
          return { address: SERVER_ADDRESS };
        }).pipe(Effect.orDie),
      serve: (options) =>
        Effect.gen(function* () {
          const exit = yield* Deferred.make<Option.Option<number>>();
          const running = yield* Ref.make(true);
          const stop = Ref.set(running, false).pipe(
            Effect.andThen(Deferred.succeed(exit, Option.none())),
            Effect.asVoid,
          );
          yield* Effect.addFinalizer(() => stop);
          const handle: TailcatRuntime.TailcatServeHandle = {
            pid: nextPid++,
            address: SERVER_ADDRESS,
            localPort: options.localPort,
            allow: options.allow,
            exit: Deferred.await(exit),
            isRunning: Ref.get(running),
            recentOutput: Effect.succeed([`listening on 127.0.0.1:${options.localPort}`]),
            stop,
          };
          yield* Queue.offer(fake.serves, { options, exit, isRunning: Ref.get(running) });
          return handle;
        }),
    });
  }),
).pipe(Layer.provideMerge(FakeTailcat.layer));

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    }),
  ),
);

const serverEnvironmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
  getDescriptor: Effect.succeed(DESCRIPTOR),
});

const makeTestLayer = () =>
  TailcatRemoteAccess.layer.pipe(
    Layer.provideMerge(fakeRuntimeLayer),
    Layer.provideMerge(authLayer),
    Layer.provide(serverEnvironmentLayer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailcat-remote-access-test-" }),
    ),
  );

const PersistedStateJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    enabled: Schema.Boolean,
    trustedPeers: Schema.Array(TailcatTrustedPeer),
  }),
);
const decodePersistedState = Schema.decodeUnknownSync(PersistedStateJson);

const readPersistedState = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem.readFileString(
    path.join(config.stateDir, TailcatRemoteAccess.TAILCAT_REMOTE_ACCESS_STATE_FILE),
  );
  return decodePersistedState(raw);
});

/**
 * `changes` only carries publishes made after subscribing, so the watcher is
 * forked (and subscribed) synchronously before the caller triggers anything.
 * Join it to get the first published state matching `predicate`.
 */
const watchState = (predicate: (state: TailcatRemoteAccessState) => boolean) =>
  Effect.gen(function* () {
    const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
    return yield* Effect.forkChild(
      service.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow)),
      { startImmediately: true },
    );
  });

/** Binds the service to the local port, enables it, and waits for the first listener. */
const startEnabled = Effect.gen(function* () {
  const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
  const fake = yield* FakeTailcat;
  const ready = yield* watchState((state) => state.status === "ready");
  yield* service.start({ localPort: LOCAL_PORT });
  const enabled = yield* service.setEnabled(true);
  yield* TestClock.adjust(RELOCK_DEBOUNCE);
  const serve = yield* Queue.take(fake.serves);
  const state = yield* Fiber.join(ready);
  return { enabled, serve, state };
});

it.layer(NodeServices.layer)("TailcatRemoteAccess", (it) => {
  it.effect("stays disabled and spawns nothing while remote access is off", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      const reconcileAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(RELOCK_DEBOUNCE);
      const reconciled = yield* watchState((state) => Date.parse(state.updatedAt) >= reconcileAt);

      yield* service.start({ localPort: LOCAL_PORT });
      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const state = yield* Fiber.join(reconciled);

      expect(state).toMatchObject({
        enabled: false,
        status: "disabled",
        address: null,
        pairingOpen: false,
        trustedPeers: [],
        runtime: null,
        identityFingerprint: null,
        lastError: null,
      });
      expect(yield* Queue.size(fake.serves)).toBe(0);
      expect(yield* Ref.get(fake.identityGenerations)).toBe(0);
      expect(yield* service.readyEndpoint).toEqual(Option.none());
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("enabling creates the identity once and serves a locked listener", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const { enabled, serve, state } = yield* startEnabled;

      // setEnabled answers immediately; the listener comes up after the debounce.
      expect(enabled.enabled).toBe(true);
      expect(enabled.status).toBe("disabled");
      expect(serve.options).toEqual({
        keyPath: path.join(config.secretsDir, TailcatRemoteAccess.TAILCAT_SERVER_IDENTITY_FILE),
        localPort: LOCAL_PORT,
        allow: { _tag: "keys", nodeKeys: [] },
      });
      expect(yield* Ref.get(fake.identityGenerations)).toBe(1);
      expect(yield* fileSystem.exists(serve.options.keyPath)).toBe(true);
      expect(state).toMatchObject({
        enabled: true,
        status: "ready",
        address: SERVER_ADDRESS,
        remotePort: LOCAL_PORT,
        pairingOpen: false,
        trustedPeers: [],
        runtime: RUNTIME_INFO,
        identityFingerprint: SERVER_FINGERPRINT,
        lastError: null,
      });
      expect(yield* service.readyEndpoint).toEqual(
        Option.some({ address: SERVER_ADDRESS, port: LOCAL_PORT }),
      );
      expect((yield* readPersistedState).enabled).toBe(true);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("a connection code carries a one-time pairing token and opens the listener", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
      const { serve: locked } = yield* startEnabled;

      const opened = yield* watchState((state) => state.pairingOpen && state.status === "ready");
      const issuedAt = yield* Clock.currentTimeMillis;
      const result = yield* service.createConnectionCode({});
      const payload = decodeTailcatConnectionCode(result.code);

      expect(result.code.startsWith("t3c://tailcat/")).toBe(true);
      expect(payload).toEqual(result.payload);
      expect(payload).toMatchObject({
        v: 1,
        transport: "tailcat",
        address: SERVER_ADDRESS,
        port: LOCAL_PORT,
        environmentId: ENVIRONMENT_ID,
        name: DESCRIPTOR.label,
        serverVersion: DESCRIPTOR.serverVersion,
        expiresAt: result.expiresAt,
      });
      expect(Date.parse(result.expiresAt) - issuedAt).toBe(
        TAILCAT_CONNECTION_CODE_DEFAULT_TTL_SECONDS * 1_000,
      );
      const link = (yield* pairingLinks.listActive()).find(
        (candidate) => candidate.id === result.pairingLinkId,
      );
      expect(link?.subject).toBe(TAILCAT_CONNECTION_CODE_PAIRING_SUBJECT);
      expect(link?.credential).toBe(payload.pairingToken);

      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const open = yield* Queue.take(fake.serves);
      const state = yield* Fiber.join(opened);

      expect(open.options.allow).toEqual({ _tag: "all" });
      expect(yield* locked.isRunning).toBe(false);
      expect(state.address).toBe(SERVER_ADDRESS);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("relocks the listener once the connection code expires", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      yield* startEnabled;
      yield* service.createConnectionCode({ ttlSeconds: 60 });
      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const open = yield* Queue.take(fake.serves);
      expect(open.options.allow).toEqual({ _tag: "all" });

      const closed = yield* watchState((state) => !state.pairingOpen && state.status === "ready");
      // Past the code's expiry (plus the service's grace second), then the debounce.
      yield* TestClock.adjust(Duration.seconds(61));
      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const relocked = yield* Queue.take(fake.serves);
      const state = yield* Fiber.join(closed);

      expect(relocked.options.allow).toEqual({ _tag: "keys", nodeKeys: [] });
      expect(yield* open.isRunning).toBe(false);
      expect(state.pairingOpen).toBe(false);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("trusted peers are persisted, admitted on relock, and revocable", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      const { serve: locked } = yield* startEnabled;
      const sessionId = AuthSessionId.make("session-julius-iphone");

      yield* service.recordTrustedPeer({
        nodeKey: PEER_NODE_KEY,
        label: "  Julius iPhone ",
        sessionId,
      });
      const recorded = yield* service.state;
      expect(recorded.trustedPeers).toHaveLength(1);
      const peer = recorded.trustedPeers[0]!;
      expect(peer).toMatchObject({
        nodeKey: PEER_NODE_KEY,
        label: "Julius iPhone",
        sessionIds: [sessionId],
      });
      expect((yield* readPersistedState).trustedPeers).toEqual([peer]);

      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const admitting = yield* Queue.take(fake.serves);
      expect(admitting.options.allow).toEqual({ _tag: "keys", nodeKeys: [PEER_NODE_KEY] });
      expect(yield* locked.isRunning).toBe(false);

      const revoked = yield* service.revokeTrustedPeer(peer.id);
      expect(revoked.trustedPeers).toEqual([]);
      expect((yield* readPersistedState).trustedPeers).toEqual([]);

      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const relocked = yield* Queue.take(fake.serves);
      expect(relocked.options.allow).toEqual({ _tag: "keys", nodeKeys: [] });
      expect(yield* admitting.isRunning).toBe(false);

      const missing = yield* Effect.flip(service.revokeTrustedPeer(peer.id));
      expect(missing.code).toBe("unknown");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("an unexpected listener exit is reported and retried after the backoff", () =>
    Effect.gen(function* () {
      const fake = yield* FakeTailcat;
      const { serve: first } = yield* startEnabled;

      const failed = yield* watchState((state) => state.status === "error");
      yield* Deferred.succeed(first.exit, Option.some(1));
      const errorState = yield* Fiber.join(failed);

      expect(errorState.lastError).toMatchObject({ code: "process-exited" });
      expect(errorState.lastError?.message).toContain("exited (1)");
      // A transient failure keeps the stable address; only permanent ones drop it.
      expect(errorState.address).toBe(SERVER_ADDRESS);

      const restarted = yield* watchState(
        (state) => state.status === "ready" && state.lastError === null,
      );
      yield* TestClock.adjust(FIRST_RETRY_BACKOFF_MAX);
      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const second = yield* Queue.take(fake.serves);
      const readyState = yield* Fiber.join(restarted);

      expect(second.options.allow).toEqual({ _tag: "keys", nodeKeys: [] });
      expect(readyState.address).toBe(SERVER_ADDRESS);
      // The identity file survived the restart, so no new address was minted.
      expect(yield* Ref.get(fake.identityGenerations)).toBe(1);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("disabling stops the listener and reports disabled", () =>
    Effect.gen(function* () {
      const service = yield* TailcatRemoteAccess.TailcatRemoteAccess;
      const fake = yield* FakeTailcat;
      const { serve } = yield* startEnabled;

      const disabled = yield* watchState((state) => state.status === "disabled");
      const returned = yield* service.setEnabled(false);
      expect(returned.enabled).toBe(false);

      yield* TestClock.adjust(RELOCK_DEBOUNCE);
      const state = yield* Fiber.join(disabled);

      expect(state).toMatchObject({
        enabled: false,
        status: "disabled",
        address: null,
        identityFingerprint: null,
        lastError: null,
      });
      expect(yield* serve.isRunning).toBe(false);
      expect(yield* service.readyEndpoint).toEqual(Option.none());
      expect((yield* readPersistedState).enabled).toBe(false);
      expect(yield* Queue.size(fake.serves)).toBe(0);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
