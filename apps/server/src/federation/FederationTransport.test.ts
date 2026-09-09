import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type TailcatNodeKey } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { TailcatCommandError } from "@t3tools/tailcat/errors";
import * as TailcatRuntime from "@t3tools/tailcat/runtime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as FederationTransport from "./FederationTransport.ts";

const NODE_KEY: TailcatNodeKey =
  "nodekey:9ab555a4a588b75d2054adb683db82461bb6c707d43e8ba39439f8eb1e821503";

const identityTestLayer = (runtime: Partial<TailcatRuntime.TailcatRuntime["Service"]>) =>
  FederationTransport.layer.pipe(
    Layer.updateService(FileSystem.FileSystem, (fileSystem) => ({
      ...fileSystem,
      exists: () => Effect.succeed(false),
    })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TailcatRuntime.TailcatRuntime)(runtime),
        Layer.mock(NetService.NetService)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Identity lookup must not make HTTP requests")),
        ),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-federation-identity-test-" }),
      ),
    ),
  );

it.effect("concurrent callers share one client identity and reuse it after creation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const generations = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const transport = yield* FederationTransport.FederationTransport;
      const first = yield* transport.clientNodeKey.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      const second = yield* transport.clientNodeKey.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);

      assert.equal(yield* Fiber.join(first), NODE_KEY);
      assert.equal(yield* Fiber.join(second), NODE_KEY);
      assert.equal(yield* transport.clientNodeKey, NODE_KEY);
      assert.equal(yield* Ref.get(generations), 1);
    }).pipe(
      Effect.provide(
        identityTestLayer({
          generateClientIdentity: () =>
            Effect.gen(function* () {
              yield* Ref.update(generations, (count) => count + 1);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return { nodeKey: NODE_KEY };
            }),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries client identity creation after a failed attempt", () =>
  Effect.gen(function* () {
    const generations = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const transport = yield* FederationTransport.FederationTransport;
      const error = yield* transport.clientNodeKey.pipe(Effect.flip);
      assert.equal(error.code, "transport-unavailable");
      assert.equal(yield* transport.clientNodeKey, NODE_KEY);
      assert.equal(yield* transport.clientNodeKey, NODE_KEY);
      assert.equal(yield* Ref.get(generations), 2);
    }).pipe(
      Effect.provide(
        identityTestLayer({
          generateClientIdentity: () =>
            Effect.gen(function* () {
              if ((yield* Ref.updateAndGet(generations, (count) => count + 1)) === 1) {
                return yield* new TailcatCommandError({
                  subcommand: "genkey",
                  exitCode: 1,
                  detail: "Temporary key generation failure",
                });
              }
              return { nodeKey: NODE_KEY };
            }),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reuses a fresh forward until idle expiry and reopens it on demand", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 hour");
    const closed = yield* Queue.unbounded<number>();
    const nextPort = yield* Ref.make(40_000);
    const runtime = Layer.mock(TailcatRuntime.TailcatRuntime)({
      generateClientIdentity: () => Effect.succeed({ nodeKey: NODE_KEY }),
      forward: (options) =>
        Effect.gen(function* () {
          const running = yield* Ref.make(true);
          const stop = Ref.set(running, false).pipe(
            Effect.andThen(Queue.offer(closed, options.localPort)),
            Effect.asVoid,
          );
          yield* Effect.addFinalizer(() => stop);
          return {
            pid: options.localPort,
            address: options.address,
            remotePort: options.remotePort,
            localPort: options.localPort,
            httpBaseUrl: `http://127.0.0.1:${options.localPort}`,
            wsBaseUrl: `ws://127.0.0.1:${options.localPort}`,
            exit: Effect.never,
            isRunning: Ref.get(running),
            recentOutput: Effect.succeed([]),
            stop,
          };
        }),
    });
    const transport = yield* FederationTransport.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          runtime,
          Layer.mock(NetService.NetService)({
            reserveLoopbackPort: () => Ref.updateAndGet(nextPort, (port) => port + 1),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Mock forwards must not make HTTP requests")),
          ),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-federation-transport-test-" }),
        ),
      ),
    );
    const peer = {
      peerId: EnvironmentId.make("environment-peer"),
      transport: {
        tailcat: {
          address:
            "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu",
          port: 3773,
        },
      },
    };
    const first = yield* transport.endpointFor(peer);
    assert.deepEqual(yield* transport.endpointFor(peer), first);
    assert.equal(yield* Ref.get(nextPort), first.localPort);

    yield* TestClock.adjust("9 minutes");
    assert.isTrue(yield* transport.isActive(peer.peerId));
    yield* TestClock.adjust("2 minutes");
    assert.equal(yield* Queue.take(closed), first.localPort);
    assert.isFalse(yield* transport.isActive(peer.peerId));

    const reopened = yield* transport.endpointFor(peer);
    assert.notEqual(reopened.localPort, first.localPort);
    assert.isTrue(yield* transport.isActive(peer.peerId));
    yield* transport.drop(peer.peerId);
    assert.equal(yield* Queue.take(closed), reopened.localPort);
    assert.isFalse(yield* transport.isActive(peer.peerId));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
