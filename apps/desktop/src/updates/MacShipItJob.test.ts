import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { removeLeftoverShipItJob } from "./MacShipItJob.ts";

const encoder = new TextEncoder();
const TARGET = "gui/501/com.t3tools.t3code.ShipIt";

const makeHandle = (output: string, exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(output)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const run = (input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly print: { readonly output: string; readonly exitCode: number };
  readonly reprint?: { readonly output: string; readonly exitCode: number };
}) =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    let prints = 0;
    yield* removeLeftoverShipItJob().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return Effect.die("unexpected piped command");
          commands.push([command.command, ...command.args.map(String)]);
          if (command.args[0] !== "print") return Effect.succeed(makeHandle("", 0));
          const print = prints++ === 0 ? input.print : (input.reprint ?? input.print);
          return Effect.succeed(makeHandle(print.output, print.exitCode));
        }),
      ),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        platform: input.platform,
        isPackaged: input.isPackaged,
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(HostProcess.UserId, 501),
    );
    return commands;
  });

const PRINT = ["/bin/launchctl", "print", TARGET];
const IDLE_JOB = `${TARGET} = {\n\tactive count = 0\n\tstate = not running\n}\n`;
const RUNNING_JOB = `${TARGET} = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n}\n`;

describe("removeLeftoverShipItJob", () => {
  it.effect("boots out a loaded ShipIt job that is not running", () =>
    Effect.gen(function* () {
      const commands = yield* run({
        platform: "darwin",
        isPackaged: true,
        print: { output: IDLE_JOB, exitCode: 0 },
      });
      assert.deepEqual(commands, [PRINT, PRINT, ["/bin/launchctl", "bootout", TARGET]]);
    }),
  );

  it.effect("leaves a running or missing ShipIt job alone", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* run({
          platform: "darwin",
          isPackaged: true,
          print: { output: RUNNING_JOB, exitCode: 0 },
        }),
        [PRINT],
      );
      assert.deepEqual(
        yield* run({
          platform: "darwin",
          isPackaged: true,
          print: { output: "Could not find service", exitCode: 113 },
        }),
        [PRINT],
      );
    }),
  );

  it.effect("leaves the job alone when ShipIt starts before the unload", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* run({
          platform: "darwin",
          isPackaged: true,
          print: { output: IDLE_JOB, exitCode: 0 },
          reprint: { output: RUNNING_JOB, exitCode: 0 },
        }),
        [PRINT, PRINT],
      );
    }),
  );

  it.effect("never runs launchctl off packaged macOS", () =>
    Effect.gen(function* () {
      const print = { output: IDLE_JOB, exitCode: 0 };
      assert.deepEqual(yield* run({ platform: "darwin", isPackaged: false, print }), []);
      assert.deepEqual(yield* run({ platform: "linux", isPackaged: true, print }), []);
    }),
  );
});
