import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { releaseIdleShipItJob } from "./MacShipItJob.ts";

const LABEL = "com.t3tools.t3code.ShipIt";
const UID = 501;
const PRINT = ["/bin/launchctl", "print", `gui/${UID}/${LABEL}`] as const;
const REMOVE = ["/bin/launchctl", "remove", LABEL] as const;

interface ScriptStep {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly fail?: boolean;
}

function shipItPrint(fields: {
  readonly state?: string;
  readonly pid?: number | string;
  readonly activeCount?: number;
  readonly lastExitCode?: number;
  readonly runs?: number;
  readonly nested?: boolean;
}): string {
  const lines = [`gui/${UID}/${LABEL} = {`];
  if (fields.activeCount !== undefined) lines.push(`\tactive count = ${fields.activeCount}`);
  if (fields.state !== undefined) lines.push(`\tstate = ${fields.state}`);
  if (fields.pid !== undefined) lines.push(`\tpid = ${fields.pid}`);
  if (fields.runs !== undefined) lines.push(`\truns = ${fields.runs}`);
  if (fields.lastExitCode !== undefined) lines.push(`\tlast exit code = ${fields.lastExitCode}`);
  if (fields.nested !== false) {
    lines.push("\tresource coalition = {", "\t\tstate = active", "\t\tactive count = 1", "\t}");
  }
  lines.push("}");
  return lines.join("\n");
}

const idlePrint = shipItPrint({
  state: "not running",
  activeCount: 0,
  lastExitCode: 0,
  runs: 1,
});

function commandLine(command: ChildProcess.Command): ReadonlyArray<string> {
  if (!ChildProcess.isStandardCommand(command)) return [];
  return [
    command.command,
    ...command.args.map((arg) => (typeof arg === "string" ? arg : String(arg))),
  ];
}

function run(input: {
  readonly platform?: NodeJS.Platform;
  readonly bundleId?: string;
  readonly userId?: number | null;
  readonly steps?: ReadonlyArray<ScriptStep>;
  readonly expected: ReadonlyArray<ReadonlyArray<string>>;
}) {
  const commands: Array<ReadonlyArray<string>> = [];
  const steps = [...(input.steps ?? [])];
  return releaseIdleShipItJob({
    platform: input.platform ?? "darwin",
    bundleId: input.bundleId ?? "com.t3tools.t3code",
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(commandLine(command));
        const step = steps.shift();
        if (step === undefined || step.fail === true) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          );
        }
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(step.exitCode ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(step.stdout ?? "")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
    Effect.provideService(
      HostProcess.UserId,
      input.userId === null ? undefined : (input.userId ?? UID),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepEqual(commands, input.expected);
      }),
    ),
  );
}

it.effect(
  "drops a leftover ShipIt job only when macOS left it idle after a successful install",
  () =>
    Effect.gen(function* () {
      const cases = [
        { platform: "linux" as const, expected: [] },
        { platform: "win32" as const, expected: [] },
        { bundleId: "not a bundle id", expected: [] },
        { bundleId: "../ShipIt", expected: [] },
        { userId: null, expected: [] },
        { userId: -1, expected: [] },
        { userId: 1.5, expected: [] },
        {
          steps: [{ exitCode: 113, stdout: "Could not find service" }],
          expected: [PRINT],
        },
        {
          steps: [{ fail: true }],
          expected: [PRINT],
        },
        {
          steps: [{ stdout: idlePrint }, { exitCode: 0 }],
          expected: [PRINT, REMOVE],
        },
        {
          bundleId: "com.t3tools.t3code.dev.local",
          steps: [{ stdout: idlePrint }, { exitCode: 0 }],
          expected: [
            ["/bin/launchctl", "print", `gui/${UID}/com.t3tools.t3code.dev.local.ShipIt`],
            ["/bin/launchctl", "remove", "com.t3tools.t3code.dev.local.ShipIt"],
          ],
        },
        {
          steps: [
            {
              stdout: shipItPrint({
                state: "running",
                pid: 64038,
                activeCount: 1,
                lastExitCode: 0,
                runs: 1,
              }),
            },
          ],
          expected: [PRINT],
        },
        {
          steps: [
            {
              stdout: shipItPrint({
                state: "not running",
                pid: 64038,
                activeCount: 0,
                lastExitCode: 0,
                runs: 1,
              }),
            },
          ],
          expected: [PRINT],
        },
        {
          steps: [
            {
              stdout: shipItPrint({
                state: "spawn scheduled",
                activeCount: 1,
                runs: 0,
              }),
            },
          ],
          expected: [PRINT],
        },
        {
          steps: [
            {
              stdout: shipItPrint({
                state: "not running",
                activeCount: 0,
                lastExitCode: 1,
                runs: 2,
              }),
            },
          ],
          expected: [PRINT],
        },
        {
          steps: [{ stdout: shipItPrint({ state: "not running", nested: false }) }],
          expected: [PRINT],
        },
        {
          steps: [{ stdout: "not launchctl output" }],
          expected: [PRINT],
        },
        {
          steps: [{ stdout: idlePrint }, { exitCode: 1 }],
          expected: [PRINT, REMOVE],
        },
        {
          steps: [{ stdout: idlePrint }, { fail: true }],
          expected: [PRINT, REMOVE],
        },
      ];

      for (const scenario of cases) {
        yield* run(scenario);
      }
    }),
);
