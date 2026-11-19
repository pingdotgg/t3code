import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readGtkPrimaryPasteEnabled } from "./DesktopPrimaryPaste.ts";

const encoder = new TextEncoder();

const spawnerWithStdout = (
  stdout: Stream.Stream<Uint8Array> | ((command: string) => Stream.Stream<Uint8Array>),
) =>
  ChildProcessSpawner.make((command) =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout:
          typeof stdout === "function"
            ? stdout(command._tag === "StandardCommand" ? command.command : "")
            : stdout,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const read = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  desktop = "ubuntu:GNOME",
) =>
  readGtkPrimaryPasteEnabled.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Environment, { XDG_CURRENT_DESKTOP: desktop }),
  );

describe("readGtkPrimaryPasteEnabled", () => {
  it.effect("is disabled only when gsettings prints false", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* read(spawnerWithStdout(Stream.make(encoder.encode("false\n")))));
      assert.isTrue(yield* read(spawnerWithStdout(Stream.make(encoder.encode("true\n")))));
      // A missing schema prints nothing on stdout.
      assert.isTrue(yield* read(spawnerWithStdout(Stream.empty)));
    }),
  );

  it.effect("outside GNOME, honours only a value the user set", () =>
    Effect.gen(function* () {
      // gsettings reports the schema default, which only GNOME applies; dconf prints nothing when unset.
      const unset = spawnerWithStdout((command) =>
        command === "gsettings" ? Stream.make(encoder.encode("false\n")) : Stream.empty,
      );
      assert.isFalse(yield* read(unset, "ubuntu:GNOME"));
      assert.isTrue(yield* read(unset, "XFCE"));
      assert.isTrue(yield* read(unset, ""));
      const userSet = spawnerWithStdout((command) =>
        command === "dconf" ? Stream.make(encoder.encode("false\n")) : Stream.empty,
      );
      assert.isFalse(yield* read(userSet, "Hyprland"));
    }),
  );

  it.effect("stays enabled when gsettings cannot run", () =>
    Effect.gen(function* () {
      const missing = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "gsettings not found",
          }),
        ),
      );
      assert.isTrue(yield* read(missing));
    }),
  );

  it.effect("stays enabled when gsettings hangs", () =>
    Effect.gen(function* () {
      const fiber = yield* read(spawnerWithStdout(Stream.never)).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* Fiber.join(fiber));
    }),
  );
});
