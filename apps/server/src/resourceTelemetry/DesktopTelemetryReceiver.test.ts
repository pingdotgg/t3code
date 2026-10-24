// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { DesktopHostTelemetryMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { UpdateRestartPolicy, UpdateRestartPolicyError } from "../updateRestartPolicy.ts";
import { describe, expect, vi } from "vite-plus/test";
import * as DesktopTelemetryReceiver from "./DesktopTelemetryReceiver.ts";

import {
  applyUpdateRestartPolicy,
  requireDesktopTelemetryWriteProgress,
} from "./DesktopTelemetryReceiver.ts";

vi.mock("node:fs", { spy: true });
vi.mock("node:net", { spy: true });

describe("DesktopTelemetryReceiver", () => {
  it.effect("records contact and keeps reading after a policy ACK write fails", () =>
    Effect.gen(function* () {
      const readable = new NodeNet.Socket();
      const closed = yield* Deferred.make<void>();
      readable.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
      using _socket = vi.spyOn(NodeNet, "Socket").mockImplementation(function () {
        return readable;
      });
      using _write = vi.spyOn(NodeFS, "write").mockImplementation(() => {
        throw new Error("control pipe unavailable");
      });
      const config = yield* ServerConfig.ServerConfig;
      const receiver = yield* DesktopTelemetryReceiver.make().pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopTelemetryFd: 7,
          desktopTelemetryControlFd: 8,
        }),
      );
      const subscription = yield* receiver.subscribeHealth;
      const nextHealth = yield* Stream.toPull(subscription.changes);
      const hello = {
        version: 1,
        type: "desktopTelemetryHello",
        electronPid: 123,
      } satisfies typeof DesktopHostTelemetryMessage.Encoded;
      readable.push(Buffer.from(`${JSON.stringify(hello)}\n`));
      yield* nextHealth;
      yield* TestClock.adjust("60 seconds");
      readable.push(
        Buffer.from(
          `${JSON.stringify({
            version: 1,
            type: "desktopUpdateRestartPolicy",
            requestId: "attempt",
            continueRunningThreads: false,
          })}\n`,
        ),
      );
      yield* nextHealth;
      yield* TestClock.adjust("60 seconds");
      expect.soft(Option.getOrNull((yield* receiver.health).lastError)).toContain("control");
      const report = {
        version: 1,
        type: "desktopUpdateStatus",
        requestId: "later-update",
        state: {
          enabled: true,
          status: "idle",
          channel: "latest",
          currentVersion: "1.0.0",
          hostArch: "x64",
          appArch: "x64",
          runningUnderArm64Translation: false,
          availableVersion: null,
          downloadedVersion: null,
          releaseNotes: [],
          omittedReleaseCount: 0,
          downloadPercent: null,
          checkedAt: null,
          message: null,
          errorContext: null,
          canRetry: false,
        },
      } satisfies typeof DesktopHostTelemetryMessage.Encoded;
      const snapshot = {
        version: 1,
        type: "desktopTelemetry",
        sequence: 1,
        sampledAtUnixMs: 120_000,
        electronPid: 123,
        power: {
          source: "electron-main",
          idle: "false",
          idleSeconds: 0,
          locked: "false",
          suspended: false,
          onBattery: "false",
          lowPowerMode: "false",
          thermalState: "nominal",
          stale: false,
          updatedAt: "1970-01-01T00:02:00.000Z",
        },
        speedLimitPercent: null,
        electronProcesses: [],
      } satisfies typeof DesktopHostTelemetryMessage.Encoded;
      readable.push(
        Buffer.from(
          [{ ...hello, supportsUpdateThreadContinuationControl: true }, report, snapshot]
            .map((message) => JSON.stringify(message))
            .join("\n") + "\n",
        ),
      );
      readable.push(null);
      yield* Deferred.await(closed);
      expect(Option.getOrNull(yield* receiver.latest)?.sequence).toBe(1);
      expect(Option.getOrNull((yield* receiver.desktopUpdates).latest)?.requestId).toBe(
        "later-update",
      );
      expect(yield* receiver.supportsUpdateThreadContinuationControl).toBe(true);
      expect((yield* receiver.health).status).toBe("stopped");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "desktop-policy-ack-" }),
          ServerSettings.layerTest(),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});

it.effect("acknowledges the exact resume choice only after policy persistence", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const persisted = yield* Deferred.make<void>();
    const task = applyUpdateRestartPolicy({
      version: 1,
      type: "desktopUpdateRestartPolicy",
      requestId: "attempt",
      continueRunningThreads: false,
    }).pipe(
      Effect.provideService(UpdateRestartPolicy, {
        set: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(persisted))),
        capture: () => Effect.void,
        isVetoed: () => Effect.succeed(false),
      }),
    );
    const fiber = yield* task.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(persisted, undefined);
    expect(yield* Fiber.join(fiber)).toEqual({
      version: 1,
      type: "desktopUpdateRestartPolicyResult",
      requestId: "attempt",
      continueRunningThreads: false,
      accepted: true,
    });
  }),
);

it.effect("refuses the native choice when persistence fails", () =>
  Effect.gen(function* () {
    const result = yield* applyUpdateRestartPolicy({
      version: 1,
      type: "desktopUpdateRestartPolicy",
      requestId: "attempt",
      continueRunningThreads: true,
    }).pipe(
      Effect.provideService(UpdateRestartPolicy, {
        set: () => Effect.fail(new UpdateRestartPolicyError({ cause: "disk failure" })),
        capture: () => Effect.void,
        isVetoed: () => Effect.succeed(false),
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.continueRunningThreads).toBe(true);
  }),
);
