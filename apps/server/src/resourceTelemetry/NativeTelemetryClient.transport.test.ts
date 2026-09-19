import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorCommand,
  ResourceMonitorEvent,
  type ResourceMonitorCommand as MonitorCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(ResourceMonitorCommand));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ResourceMonitorEvent));

const requestFor = (
  client: NativeTelemetryClient.NativeTelemetryClient["Service"],
  operation: "sampleNow" | "processTable" | "readHistory",
) => {
  switch (operation) {
    case "sampleNow":
      return client.sampleNow.pipe(Effect.asVoid);
    case "processTable":
      return client.processTable.pipe(Effect.asVoid);
    case "readHistory":
      return client.readHistory(1000).pipe(Effect.asVoid);
  }
};

const makeClient = Effect.fn(function* (
  onCommand: (
    command: MonitorCommand,
    send: (event: ResourceMonitorEvent) => Effect.Effect<boolean>,
  ) => Effect.Effect<void>,
) {
  const output = yield* Queue.unbounded<Uint8Array>();
  const send = (event: ResourceMonitorEvent) =>
    Queue.offer(output, new TextEncoder().encode(`${encodeEvent(event)}\n`));
  yield* send({
    version: RESOURCE_MONITOR_PROTOCOL_VERSION,
    type: "hello",
    sidecarVersion: "test",
    sidecarPid: 100,
    platform: "linux",
    arch: "x64",
    capabilities: {
      cumulativeCpuTime: true,
      currentCpuPercent: true,
      residentMemory: true,
      virtualMemory: true,
      ioBytes: true,
      processStartTime: true,
      processTree: true,
    },
  });
  const configured = yield* Deferred.make<void>();
  const killed = yield* Deferred.make<void>();
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Deferred.succeed(killed, undefined).pipe(Effect.asVoid),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        const command = decodeCommand(new TextDecoder().decode(bytes));
        yield* onCommand(command, send);
        if (command.type === "setExternalProcesses") yield* Deferred.succeed(configured, undefined);
      }),
    ),
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  const config = yield* Layer.build(
    ServerConfig.layerTest("/test", { prefix: "t3-telemetry-test-" }),
  );
  const client = yield* NativeTelemetryClient.make().pipe(
    Effect.provide(config),
    Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, {
      resolve: Effect.succeed("test-monitor"),
    }),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.succeed(handle)),
    ),
  );
  return { client, configured, killed, send };
});

describe("native telemetry transport deadlines", () => {
  for (const operation of ["sampleNow", "processTable", "readHistory"] as const) {
    it.effect(`bounds a stalled ${operation} write and releases the command permit`, () =>
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>();
        let blocked = true;
        const { client, configured } = yield* makeClient((command, send) =>
          command.type === operation && blocked
            ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
            : command.type === "processTable"
              ? send({
                  version: RESOURCE_MONITOR_PROTOCOL_VERSION,
                  type: "processTable",
                  requestId: command.requestId,
                  processes: [],
                }).pipe(Effect.asVoid)
              : Effect.void,
        );
        yield* Deferred.await(configured);
        const request = yield* requestFor(client, operation).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(writing);
        yield* TestClock.adjust("5 seconds");
        expect(request.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(request)).toMatchObject({
          _tag: "Failure",
          failure: { operation },
        });
        blocked = false;
        expect(yield* client.processTable).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  for (const operation of ["sampleNow", "processTable", "readHistory"] as const) {
    it.effect(`includes mutex wait time in the ${operation} response deadline`, () =>
      Effect.gen(function* () {
        const blocking = yield* Deferred.make<void>();
        let blockExternal = false;
        const { client, configured } = yield* makeClient((command) =>
          blockExternal && command.type === "setExternalProcesses"
            ? Deferred.succeed(blocking, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        );
        yield* Deferred.await(configured);
        blockExternal = true;
        const blockedWrite = yield* client
          .setExternalProcesses([])
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(blocking);
        yield* TestClock.adjust("2 seconds");
        const request = yield* requestFor(client, operation).pipe(
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(operation === "readHistory" ? "15 seconds" : "5 seconds");
        expect(request.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(request)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "NativeTelemetryRequestTimedOut",
            operation,
            timeoutMs: operation === "readHistory" ? 15000 : 5000,
          },
        });
        expect(yield* Fiber.join(blockedWrite)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "NativeTelemetryCommandTimedOut",
            operation: "setExternalProcesses",
            timeoutMs: 5000,
          },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("releases a sidecar when its startup configure write stalls", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const { client, killed } = yield* makeClient((command) =>
        command.type === "configure"
          ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      yield* Deferred.await(writing);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Deferred.isDone(killed)).toBe(true);
      expect(yield* client.health).toMatchObject({ status: "degraded", restartCount: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back demand when acquiring a live subscription times out", () =>
    Effect.gen(function* () {
      const enabling = yield* Deferred.make<void>();
      const { client, configured } = yield* makeClient((command) =>
        command.type === "setSampleInterval" && command.sampleIntervalMs === 1000
          ? Deferred.succeed(enabling, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      yield* Deferred.await(configured);
      const subscription = yield* client.snapshots.pipe(
        Stream.runDrain,
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(enabling);
      yield* TestClock.adjust("5 seconds");
      expect(subscription.pollUnsafe()).toBeDefined();
      expect(yield* Fiber.join(subscription)).toMatchObject({
        _tag: "Failure",
        failure: { operation: "setSampleInterval" },
      });
      expect(yield* client.health).toMatchObject({ sampleIntervalMs: 5000 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([false, true])(
    "corrects partial control with rollback stalled=%s",
    (stallRollback) =>
      Effect.gen(function* () {
        const enabling = yield* Deferred.make<void>();
        const commands: Array<MonitorCommand> = [];
        let interval = 5000;
        let streaming = false;
        let rollbackStalled = false;
        const { client, configured } = yield* makeClient((command) =>
          Effect.gen(function* () {
            if (command.type === "setSampleInterval") {
              commands.push(command);
              interval = command.sampleIntervalMs;
            }
            if (command.type === "setStreaming") {
              commands.push(command);
              streaming = command.enabled;
              if (command.enabled) {
                yield* Deferred.succeed(enabling, undefined);
                return yield* Effect.never;
              }
              if (stallRollback && !rollbackStalled) {
                rollbackStalled = true;
                return yield* Effect.never;
              }
            }
          }),
        );
        yield* Deferred.await(configured);
        const subscription = yield* client.snapshots.pipe(
          Stream.runDrain,
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(enabling);
        expect(interval).toBe(1000);
        expect(streaming).toBe(true);
        yield* TestClock.adjust("5 seconds");
        if (stallRollback) yield* TestClock.adjust("5 seconds");
        expect(subscription.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(subscription)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "setStreaming" },
        });
        expect(commands).toEqual([
          {
            version: RESOURCE_MONITOR_PROTOCOL_VERSION,
            type: "setSampleInterval",
            sampleIntervalMs: 1000,
          },
          { version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "setStreaming", enabled: true },
          {
            version: RESOURCE_MONITOR_PROTOCOL_VERSION,
            type: "setSampleInterval",
            sampleIntervalMs: 5000,
          },
          { version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "setStreaming", enabled: false },
        ]);
        expect(interval).toBe(5000);
        expect(streaming).toBe(false);
        if (stallRollback) {
          yield* client.setHostPowerState({
            source: "unknown",
            idle: "unknown",
            idleSeconds: null,
            locked: "unknown",
            suspended: false,
            onBattery: "unknown",
            lowPowerMode: "unknown",
            thermalState: "unknown",
            stale: true,
            updatedAt: yield* DateTime.now,
          });
          expect(commands.slice(4)).toEqual(commands.slice(2, 4));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes scoped subscription release when disabling streaming stalls", () =>
    Effect.gen(function* () {
      const enabled = yield* Deferred.make<void>();
      const disabling = yield* Deferred.make<void>();
      const { client, configured } = yield* makeClient((command) =>
        command.type === "setStreaming"
          ? command.enabled
            ? Deferred.succeed(enabled, undefined).pipe(Effect.asVoid)
            : Deferred.succeed(disabling, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      yield* Deferred.await(configured);
      const subscription = yield* client.snapshots.pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(enabled);
      const closing = yield* Fiber.interrupt(subscription).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(disabling);
      yield* TestClock.adjust("5 seconds");
      expect(closing.pollUnsafe()).toBeDefined();
      yield* Fiber.join(closing);
      expect(yield* client.health).toMatchObject({ sampleIntervalMs: 5000 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
