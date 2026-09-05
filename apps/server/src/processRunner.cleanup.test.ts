// @effect-diagnostics nodeBuiltinImport:off - observes the native cleanup commands used by the process spawner.
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "./processRunner.ts";

// Observe native ESM consumers as well as modules loaded through the test runner.
const nativeChildProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
) as typeof NodeChildProcess;

beforeEach(() => {
  vi.spyOn(nativeChildProcess, "exec");
  NodeModule.syncBuiltinESMExports();
});
afterEach(() => {
  vi.restoreAllMocks();
  NodeModule.syncBuiltinESMExports();
});

const taskkillCalls = () =>
  vi
    .mocked(nativeChildProcess.exec)
    .mock.calls.filter(([command]) => command.startsWith("taskkill "));

it.layer(NodeServices.layer)("completed probe cleanup", (it) => {
  for (const cleanupOnExit of [false, true] as const) {
    it.effect(`preserves nonzero results with cleanupOnExit=${cleanupOnExit}`, () =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const result = yield* runner.run({
          command: process.execPath,
          args: ["-e", "process.stdout.write('probe result'); process.exitCode = 1"],
          ...(cleanupOnExit ? {} : { windowsCleanupOnExit: cleanupOnExit }),
        });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("probe result");
        if ((yield* HostProcessPlatform) === "win32") {
          expect(taskkillCalls()).toHaveLength(cleanupOnExit ? 2 : 0);
        }
      }).pipe(Effect.provide(ProcessRunner.layer)),
    );
  }

  for (const termination of ["interrupt", "timeout"] as const) {
    it.effect(`still kills running probes on ${termination}`, () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const ready = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
        const probe = Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
              { cleanupOnExit: false },
            ),
          );
          yield* Stream.runHead(child.stdout);
          yield* Deferred.succeed(ready, child);
          return yield* Effect.never;
        }).pipe(Effect.scoped);
        const fiber = yield* probe.pipe(Effect.timeoutOption("1 second"), Effect.forkChild);
        const child = yield* Deferred.await(ready);
        expect(yield* child.isRunning).toBe(true);

        if (termination === "interrupt") {
          yield* Fiber.interrupt(fiber);
        } else {
          yield* TestClock.adjust("1 second");
          expect(Option.isNone(yield* Fiber.join(fiber))).toBe(true);
        }

        expect(yield* child.isRunning).toBe(false);
        if ((yield* HostProcessPlatform) === "win32") {
          expect(taskkillCalls()).toHaveLength(1);
        }
      }),
    );
  }
});
