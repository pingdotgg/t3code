import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTailcatEnvironmentEnsureInput,
  TailcatPathProbe,
  TailcatRuntimeInfo,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { tailcatBackoffDelayMs } from "@t3tools/tailcat/backoff";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as DesktopTailcatEnvironment from "./DesktopTailcatEnvironment.ts";
import * as DesktopTailcatIdentity from "./DesktopTailcatIdentity.ts";

const CONNECTION_ID = "connection-1";
// Captured from a real `tailcat serve` run; the fake runtime never decodes it.
const ADDRESS =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";
const OTHER_ADDRESS = "tcAnotherServer_0123456789abcdefABCDEF";
const REMOTE_PORT = 3773;
const FIRST_PORT = 41000;
const NODE_KEY = `nodekey:${"7f".repeat(32)}`;
const KEY_PATH = "/tmp/fake.key";
// The TestClock starts at the epoch, so every recorded timestamp is fixed.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const RECENT_OUTPUT = ["forward: tunnel established"];
const FIRST_BACKOFF_MAX_MS = tailcatBackoffDelayMs(1, 1);
const SECOND_BACKOFF_MIN_MS = tailcatBackoffDelayMs(2, 0);
const SECOND_BACKOFF_MAX_MS = tailcatBackoffDelayMs(2, 1);

const ENSURE_INPUT = {
  connectionId: CONNECTION_ID,
  address: ADDRESS,
  remotePort: REMOTE_PORT,
} satisfies DesktopTailcatEnvironmentEnsureInput;

const RUNTIME_INFO: TailcatRuntimeInfo = {
  executablePath: "/opt/t3/resources/tailcat/linux-x64/tailcat",
  source: "bundled",
  version: "0.3.0",
  pinnedVersion: "0.3.0",
  compatible: true,
};

const PATH_PROBE: TailcatPathProbe = {
  kind: "direct",
  via: "203.0.113.5:41641",
  latencyMs: 12.5,
  measuredAt: EPOCH_ISO,
};

const DESCRIPTOR = {
  environmentId: "env-remote",
  label: "Remote Devbox",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.2.3",
  capabilities: {},
};

const httpBaseUrlFor = (localPort: number) => `http://127.0.0.1:${localPort}/`;
const probeUrlFor = (localPort: number) => `${httpBaseUrlFor(localPort)}.well-known/t3/environment`;

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

interface FakeForward {
  readonly pid: number;
  readonly input: {
    readonly keyPath: string | null;
    readonly address: string;
    readonly remotePort: number;
    readonly localPort: number;
  };
  /** Settle to simulate the forwarder process exiting on its own. */
  readonly exit: Deferred.Deferred<Option.Option<number>>;
  readonly state: {
    running: boolean;
    /** Set when the owning scope closes, which is how the runtime stops a forwarder. */
    stopped: boolean;
  };
  readonly handle: TailcatRuntime.TailcatForwardHandle;
}

interface Harness {
  readonly layer: Layer.Layer<DesktopTailcatEnvironment.DesktopTailcatEnvironment>;
  /** Every `forward` call in order, whether or not it became ready. */
  readonly forwards: ReadonlyArray<FakeForward>;
  readonly probeRequests: ReadonlyArray<string>;
  readonly pings: ReadonlyArray<{ readonly keyPath: string | null; readonly address: string }>;
  /** Whether the fake T3 server behind the tunnel answers the readiness probe. */
  readonly setRemoteHealthy: (healthy: boolean) => void;
  /** Settles once the n-th (1-based) forward has been spawned. */
  readonly spawned: (count: number) => Effect.Effect<void>;
}

function makeHarness(options?: {
  readonly resolve?: Effect.Effect<TailcatRuntimeInfo, TailcatRuntime.TailcatResolveError>;
}): Harness {
  const forwards: Array<FakeForward> = [];
  const probeRequests: Array<string> = [];
  const pings: Array<{ readonly keyPath: string | null; readonly address: string }> = [];
  const spawnSignals = new Map<number, Deferred.Deferred<void>>();
  let remoteHealthy = true;
  let nextPort = FIRST_PORT;

  const spawnSignal = (count: number) => {
    const existing = spawnSignals.get(count);
    if (existing !== undefined) {
      return existing;
    }
    const created = Deferred.makeUnsafe<void>();
    spawnSignals.set(count, created);
    return created;
  };

  const runtimeLayer = Layer.mock(TailcatRuntime.TailcatRuntime)({
    resolve: options?.resolve ?? Effect.succeed(RUNTIME_INFO),
    forward: (input) =>
      Effect.gen(function* () {
        const exit = yield* Deferred.make<Option.Option<number>>();
        const state = { running: true, stopped: false };
        const handle: TailcatRuntime.TailcatForwardHandle = {
          pid: 5000 + forwards.length + 1,
          address: input.address,
          remotePort: input.remotePort,
          localPort: input.localPort,
          httpBaseUrl: httpBaseUrlFor(input.localPort),
          wsBaseUrl: `ws://127.0.0.1:${input.localPort}/`,
          exit: Deferred.await(exit),
          isRunning: Effect.sync(() => state.running),
          recentOutput: Effect.succeed(RECENT_OUTPUT),
          stop: Effect.sync(() => {
            state.running = false;
          }),
        };
        forwards.push({
          pid: handle.pid,
          input: {
            keyPath: input.keyPath,
            address: input.address,
            remotePort: input.remotePort,
            localPort: input.localPort,
          },
          exit,
          state,
          handle,
        });
        yield* Deferred.done(spawnSignal(forwards.length), Exit.void);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.running = false;
            state.stopped = true;
          }),
        );
        if (input.readiness !== undefined) {
          // Like the runtime, a failed probe kills the forwarder before the error surfaces.
          yield* input.readiness({ httpBaseUrl: handle.httpBaseUrl }).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                state.running = false;
              }),
            ),
          );
        }
        return handle;
      }),
    ping: (input) =>
      Effect.sync(() => {
        pings.push({ keyPath: input.keyPath, address: input.address });
        return PATH_PROBE;
      }),
  });

  const identityLayer = Layer.mock(DesktopTailcatIdentity.DesktopTailcatIdentity)({
    nodeKey: Effect.succeed(NODE_KEY),
    encrypted: Effect.succeed(true),
    withKeyFile: (use) => use(KEY_PATH),
  });

  const netLayer = Layer.mock(NetService.NetService)({
    reserveLoopbackPort: () =>
      Effect.sync(() => {
        const port = nextPort;
        nextPort += 1;
        return port;
      }),
  });

  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        probeRequests.push(request.url);
        return remoteHealthy
          ? jsonResponse(request, DESCRIPTOR)
          : jsonResponse(request, { error: "server offline" }, 503);
      }),
    ),
  );

  return {
    layer: DesktopTailcatEnvironment.layer.pipe(
      Layer.provide(Layer.mergeAll(runtimeLayer, identityLayer, netLayer, httpClientLayer)),
    ),
    forwards,
    probeRequests,
    pings,
    setRemoteHealthy: (healthy) => {
      remoteHealthy = healthy;
    },
    spawned: (count) => Deferred.await(spawnSignal(count)),
  };
}

describe("DesktopTailcatEnvironment", () => {
  it.effect("ensureEnvironment forwards a reserved loopback port and reports the bootstrap", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;

      const bootstrap = yield* environment.ensureEnvironment(ENSURE_INPUT);

      assert.deepEqual(bootstrap, {
        connectionId: CONNECTION_ID,
        address: ADDRESS,
        remotePort: REMOTE_PORT,
        localPort: FIRST_PORT,
        httpBaseUrl: httpBaseUrlFor(FIRST_PORT),
        wsBaseUrl: `ws://127.0.0.1:${FIRST_PORT}/`,
        clientNodeKey: NODE_KEY,
      });
      assert.equal(harness.forwards.length, 1);
      assert.deepEqual(harness.forwards[0]?.input, {
        keyPath: KEY_PATH,
        address: ADDRESS,
        remotePort: REMOTE_PORT,
        localPort: FIRST_PORT,
      });
      assert.deepEqual(harness.probeRequests, [probeUrlFor(FIRST_PORT)]);

      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.deepEqual(diagnostics.value, {
        connectionId: CONNECTION_ID,
        address: ADDRESS,
        remotePort: REMOTE_PORT,
        status: "ready",
        localEndpoint: httpBaseUrlFor(FIRST_PORT),
        pid: 5001,
        runtime: RUNTIME_INFO,
        clientNodeKey: NODE_KEY,
        path: null,
        startedAt: EPOCH_ISO,
        restartCount: 0,
        lastError: null,
        recentOutput: RECENT_OUTPUT,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reuses a healthy forward instead of spawning again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;

      const first = yield* environment.ensureEnvironment(ENSURE_INPUT);
      const second = yield* environment.ensureEnvironment(ENSURE_INPUT);

      assert.equal(harness.forwards.length, 1);
      assert.isFalse(harness.forwards[0]?.state.stopped);
      assert.equal(second.localPort, first.localPort);
      assert.deepEqual(second, first);
      // The second call only re-probes the tunnel that is already up.
      assert.deepEqual(harness.probeRequests, [probeUrlFor(FIRST_PORT), probeUrlFor(FIRST_PORT)]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("moves a connection to a new address by replacing its forward", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;

      const first = yield* environment.ensureEnvironment(ENSURE_INPUT);
      const moved = yield* environment.ensureEnvironment({
        ...ENSURE_INPUT,
        address: OTHER_ADDRESS,
      });

      assert.equal(harness.forwards.length, 2);
      assert.isTrue(harness.forwards[0]?.state.stopped);
      assert.isFalse(harness.forwards[1]?.state.stopped);
      assert.deepEqual(harness.forwards[1]?.input, {
        keyPath: KEY_PATH,
        address: OTHER_ADDRESS,
        remotePort: REMOTE_PORT,
        localPort: FIRST_PORT + 1,
      });
      assert.equal(moved.address, OTHER_ADDRESS);
      assert.equal(moved.localPort, FIRST_PORT + 1);
      assert.notEqual(moved.localPort, first.localPort);
      assert.equal(moved.httpBaseUrl, httpBaseUrlFor(FIRST_PORT + 1));

      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.equal(diagnostics.value.address, OTHER_ADDRESS);
      assert.equal(diagnostics.value.status, "ready");
      assert.equal(diagnostics.value.pid, 5002);
      assert.equal(diagnostics.value.restartCount, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails ensureEnvironment when the remote never answers through the tunnel", () => {
    const harness = makeHarness();
    harness.setRemoteHealthy(false);
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;

      const error = yield* environment.ensureEnvironment(ENSURE_INPUT).pipe(Effect.flip);

      assert.instanceOf(error, DesktopTailcatEnvironment.DesktopTailcatEnvironmentError);
      assert.equal(error.code, "remote-unavailable");
      assert.isTrue(error.message.startsWith("[tailcat:remote-unavailable] "));
      assert.include(error.message, "not trusted");
      assert.include(error.message, "offline");
      // The failed attempt's forwarder went down with its scope.
      assert.equal(harness.forwards.length, 1);
      assert.isTrue(harness.forwards[0]?.state.stopped);

      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.equal(diagnostics.value.status, "failed");
      assert.equal(diagnostics.value.pid, null);
      assert.equal(diagnostics.value.localEndpoint, null);
      assert.equal(diagnostics.value.startedAt, null);
      assert.deepEqual(diagnostics.value.lastError, {
        code: "remote-unavailable",
        message: error.detail,
        at: EPOCH_ISO,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restarts a forward that exits on its own", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
      const first = yield* environment.ensureEnvironment(ENSURE_INPUT);
      const [initial] = harness.forwards;
      assert(initial !== undefined);

      yield* Deferred.succeed(initial.exit, Option.some(1));
      // Let the exit monitor run, then cover the longest first backoff step.
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(FIRST_BACKOFF_MAX_MS));
      yield* harness.spawned(2);
      // The next ensure waits behind the connection lock until the restart has settled.
      const after = yield* environment.ensureEnvironment(ENSURE_INPUT);

      assert.equal(harness.forwards.length, 2);
      assert.equal(after.localPort, first.localPort);
      assert.deepEqual(harness.forwards[1]?.input, initial.input);
      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.equal(diagnostics.value.status, "ready");
      assert.equal(diagnostics.value.restartCount, 1);
      assert.equal(diagnostics.value.pid, 5002);
      assert.equal(diagnostics.value.lastError, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("backs off before restarting a forward that already failed once", () => {
    const harness = makeHarness();
    harness.setRemoteHealthy(false);
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
      // The first attempt fails and counts as the connection's first consecutive failure.
      yield* environment.ensureEnvironment(ENSURE_INPUT).pipe(Effect.flip);
      harness.setRemoteHealthy(true);
      const bootstrap = yield* environment.ensureEnvironment(ENSURE_INPUT);
      assert.equal(bootstrap.localPort, FIRST_PORT);
      assert.equal(harness.forwards.length, 2);
      const running = harness.forwards[1];
      assert(running !== undefined);

      yield* Deferred.succeed(running.exit, Option.some(137));
      // Let the exit monitor record the failure and schedule the restart.
      yield* Effect.yieldNow;

      const failed = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(failed));
      assert.equal(failed.value.status, "failed");
      assert.equal(failed.value.pid, null);
      assert.equal(failed.value.restartCount, 0);
      assert.deepEqual(failed.value.lastError, {
        code: "process-exited",
        message: "The Tailcat forwarder exited with code 137.",
        at: EPOCH_ISO,
      });

      // This is the second consecutive failure, so nothing restarts before the
      // shortest jittered second step has passed.
      yield* TestClock.adjust(Duration.millis(SECOND_BACKOFF_MIN_MS - 1));
      assert.equal(harness.forwards.length, 2);
      // The longest jittered second step is enough for any random sample.
      yield* TestClock.adjust(Duration.millis(SECOND_BACKOFF_MAX_MS - SECOND_BACKOFF_MIN_MS + 1));
      assert.equal(harness.forwards.length, 3);
      yield* harness.spawned(3);
      // The next ensure waits behind the connection lock until the restart has settled.
      const after = yield* environment.ensureEnvironment(ENSURE_INPUT);

      assert.equal(after.localPort, FIRST_PORT);
      assert.equal(harness.forwards.length, 3);
      const restarted = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(restarted));
      assert.equal(restarted.value.status, "ready");
      assert.equal(restarted.value.restartCount, 1);
      assert.equal(restarted.value.pid, 5003);
      assert.equal(restarted.value.lastError, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("disconnectEnvironment stops the forward and forgets the connection", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
      yield* environment.ensureEnvironment(ENSURE_INPUT);
      const [initial] = harness.forwards;
      assert(initial !== undefined);

      yield* environment.disconnectEnvironment(CONNECTION_ID);

      assert.isTrue(initial.state.stopped);
      assert.isFalse(yield* initial.handle.isRunning);
      assert.isTrue(Option.isNone(yield* environment.diagnostics(CONNECTION_ID)));

      // The stopped forwarder's exit arrives afterwards and must not restart anything.
      yield* Deferred.succeed(initial.exit, Option.some(0));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(FIRST_BACKOFF_MAX_MS));
      assert.equal(harness.forwards.length, 1);
      assert.isTrue(Option.isNone(yield* environment.diagnostics(CONNECTION_ID)));

      // Disconnecting an unknown connection is a no-op.
      yield* environment.disconnectEnvironment(CONNECTION_ID);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("restartEnvironment replaces the forward and counts the restart", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
      const first = yield* environment.ensureEnvironment(ENSURE_INPUT);

      const restarted = yield* environment.restartEnvironment(CONNECTION_ID);

      assert.equal(harness.forwards.length, 2);
      assert.isTrue(harness.forwards[0]?.state.stopped);
      assert.isFalse(harness.forwards[1]?.state.stopped);
      assert.deepEqual(restarted, first);
      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.equal(diagnostics.value.status, "ready");
      assert.equal(diagnostics.value.restartCount, 1);
      assert.equal(diagnostics.value.pid, 5002);

      const missing = yield* environment.restartEnvironment("unknown-connection").pipe(Effect.flip);
      assert.equal(missing.code, "unknown");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("probePath records the measured path in diagnostics", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const environment = yield* DesktopTailcatEnvironment.DesktopTailcatEnvironment;
      assert.isTrue(Option.isNone(yield* environment.probePath(CONNECTION_ID)));
      assert.equal(harness.pings.length, 0);

      yield* environment.ensureEnvironment(ENSURE_INPUT);
      const probed = yield* environment.probePath(CONNECTION_ID);

      assert(Option.isSome(probed));
      assert.deepEqual(probed.value.path, PATH_PROBE);
      assert.deepEqual(harness.pings, [{ keyPath: KEY_PATH, address: ADDRESS }]);
      const diagnostics = yield* environment.diagnostics(CONNECTION_ID);
      assert(Option.isSome(diagnostics));
      assert.deepEqual(diagnostics.value.path, PATH_PROBE);
    }).pipe(Effect.provide(harness.layer));
  });
});
