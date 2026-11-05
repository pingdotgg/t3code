import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as HostScreen from "./HostScreen.ts";

const jpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
]);
const output = (code = 0): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout: "",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect.each(["success", "capture-failure", "resize-failure", "invalid", "oversized"] as const)(
  "cleans temporary images after %s",
  (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let directory = "";
      const runner = ProcessRunner.ProcessRunner.of({
        run: Effect.fn("Test.capture")(function* (input) {
          const file = input.args.at(-1)!;
          directory = file.slice(0, file.lastIndexOf("/"));
          if (input.command === "/usr/sbin/screencapture") {
            yield* fs
              .writeFile(
                file,
                mode === "invalid"
                  ? new Uint8Array([1, 2])
                  : mode === "oversized"
                    ? new Uint8Array(2_000_001)
                    : jpeg,
              )
              .pipe(Effect.orDie);
            return output(mode === "capture-failure" ? 1 : 0);
          }
          return output(mode === "resize-failure" ? 1 : 0);
        }),
      });
      const screen = yield* HostScreen.HostScreen.pipe(
        Effect.provide(
          HostScreen.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner))),
        ),
      );
      const result = yield* screen.capture().pipe(Effect.result);
      if (mode === "success") {
        expect(result).toMatchObject({ _tag: "Success", success: { width: 1, height: 1 } });
        expect(yield* screen.capture().pipe(Effect.flip)).toMatchObject({ reason: "busy" });
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: mode === "invalid" || mode === "oversized" ? "invalid-image" : "unavailable",
          },
        });
      }
      expect(directory).not.toBe("");
      expect(yield* fs.exists(directory)).toBe(false);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(NodeServices.layer),
    ),
);

it.effect("rejects non-Mac hosts without running capture", () =>
  Effect.gen(function* () {
    const runner = ProcessRunner.ProcessRunner.of({ run: () => Effect.die("Must not capture") });
    const screen = yield* HostScreen.HostScreen.pipe(
      Effect.provide(
        HostScreen.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner))),
      ),
    );
    expect(yield* screen.capture().pipe(Effect.flip)).toMatchObject({ reason: "unsupported" });
  }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(NodeServices.layer)),
);

it.effect("rejects concurrent captures and cleans up an interrupted capture", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entered = yield* Deferred.make<string>();
    const runner = ProcessRunner.ProcessRunner.of({
      run: Effect.fn("Test.holdCapture")(function* (input) {
        yield* Deferred.succeed(entered, input.args.at(-1)!);
        return yield* Effect.never;
      }),
    });
    const screen = yield* HostScreen.HostScreen.pipe(
      Effect.provide(
        HostScreen.layer.pipe(Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner))),
      ),
    );
    const pending = yield* screen.capture().pipe(Effect.forkChild);
    const file = yield* Deferred.await(entered);
    yield* TestClock.adjust("1 second");
    expect(yield* screen.capture().pipe(Effect.flip)).toMatchObject({ reason: "busy" });
    yield* Fiber.interrupt(pending);
    expect(yield* fs.exists(file.slice(0, file.lastIndexOf("/")))).toBe(false);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
  ),
);
