import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as MacShipItJob from "./MacShipItJob.ts";

const LABEL = "com.t3tools.t3code.ShipIt";
const UID = 501;
const PRINT = ["/bin/launchctl", "print", `gui/${UID}/${LABEL}`] as const;
const REMOVE = ["/bin/launchctl", "remove", LABEL] as const;

interface ScriptStep {
  readonly exitCode?: number;
  readonly stdout?: string;
}

function shipItPrint(fields: {
  readonly state: string;
  readonly pid?: number;
  readonly activeCount: number;
  readonly lastExitCode?: number;
  readonly runs: number;
}): string {
  const lines = [`gui/${UID}/${LABEL} = {`];
  lines.push(`\tactive count = ${fields.activeCount}`, `\tstate = ${fields.state}`);
  if (fields.pid !== undefined) lines.push(`\tpid = ${fields.pid}`);
  lines.push(`\truns = ${fields.runs}`);
  if (fields.lastExitCode !== undefined) lines.push(`\tlast exit code = ${fields.lastExitCode}`);
  lines.push("}");
  return lines.join("\n");
}

// `launchctl print gui/501/com.t3tools.t3code.ShipIt` on macOS 27.0.1 after
// the submitting build was uninstalled. Only the home directory is changed.
const idlePrint = [
  `gui/${UID}/${LABEL} = {`,
  "\tactive count = 0",
  "\tpath = (submitted by T3 Code (Beta)[87630])",
  "\ttype = Submitted",
  "\tstate = not running",
  "",
  "\tprogram = /Applications/T3 Code (Beta).app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt",
  "\targuments = {",
  "\t\t/Applications/T3 Code (Beta).app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt",
  "\t\tcom.t3tools.t3code.ShipIt",
  "\t\t/Users/tester/Library/Caches/com.t3tools.t3code.ShipIt/ShipItState.plist",
  "\t}",
  "",
  "\tstdout path = /Users/tester/Library/Caches/com.t3tools.t3code.ShipIt/ShipIt_stdout.log",
  "\tstderr path = /Users/tester/Library/Caches/com.t3tools.t3code.ShipIt/ShipIt_stderr.log",
  "\tinherited environment = {",
  "\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.example/Listeners",
  "\t}",
  "",
  "\tdefault environment = {",
  "\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin",
  "\t}",
  "",
  "\tenvironment = {",
  "\t\tOSLogRateLimit => 64",
  "\t\tXPC_SERVICE_NAME => com.t3tools.t3code.ShipIt",
  "\t}",
  "",
  "\tdomain = gui/501 [100020]",
  "\tasid = 100020",
  "\tminimum runtime = 2",
  "\texit timeout = 5",
  "\tnice = -1",
  "\truns = 1",
  "\tlast exit code = 0",
  "",
  "\tsemaphores = {",
  "\t\tsuccessful exit => 0",
  "\t}",
  "",
  "\tendpoints = {",
  '\t\t"com.t3tools.t3code.ShipIt" = {',
  "\t\t\tport = 0x12d66f",
  "\t\t\tactive = 0",
  "\t\t\tmanaged = 1",
  "\t\t\treset = 0",
  "\t\t\thide = 0",
  "\t\t\twatching = 1",
  "\t\t}",
  "\t}",
  "",
  "\tresource coalition = {",
  "\t\tID = 155515",
  "\t\ttype = resource",
  "\t\tstate = active",
  "\t\tactive count = 1",
  "\t\tname = com.t3tools.t3code.ShipIt",
  "\t}",
  "",
  "\tjetsam coalition = {",
  "\t\tID = 155516",
  "\t\ttype = jetsam",
  "\t\tstate = active",
  "\t\tactive count = 1",
  "\t\tname = com.t3tools.t3code.ShipIt",
  "\t}",
  "",
  "\tspawn type = daemon (3)",
  "\tjetsam priority = 40",
  "\tjetsam memory limit (active) = (unlimited)",
  "\tjetsam memory limit (inactive) = (unlimited)",
  "\tjetsamproperties category = daemon",
  "\tsubmitted job. ignore execute allowed",
  "\tjetsam thread limit = 32",
  "\tcpumon = default",
  "\tjob state = uninitialized",
  "\tsanitizer flags = 0x0",
  "",
  "\tproperties = inferred program",
  "}",
].join("\n");

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
  readonly steps?: ReadonlyArray<ScriptStep>;
  readonly expected: ReadonlyArray<ReadonlyArray<string>>;
}) {
  const commands: Array<ReadonlyArray<string>> = [];
  const steps = [...(input.steps ?? [])];
  return MacShipItJob.releaseIdleShipItJob({
    platform: input.platform ?? "darwin",
    bundleId: input.bundleId ?? "com.t3tools.t3code",
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(commandLine(command));
        const step = steps.shift();
        if (step === undefined) {
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
    Effect.provideService(HostProcess.UserId, UID),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.deepEqual(commands, input.expected);
      }),
    ),
  );
}

it.effect("drops a leftover ShipIt job only when it is idle after a successful install", () =>
  Effect.gen(function* () {
    const cases = [
      { platform: "linux" as const, expected: [] },
      { bundleId: "../ShipIt", expected: [] },
      { steps: [{ exitCode: 113, stdout: "Could not find service" }], expected: [PRINT] },
      { steps: [{ stdout: idlePrint }, { exitCode: 0 }], expected: [PRINT, REMOVE] },
      {
        // KeepAlive SuccessfulExit = false: launchd will retry the install.
        steps: [
          {
            stdout: shipItPrint({ state: "not running", activeCount: 0, lastExitCode: 1, runs: 2 }),
          },
        ],
        expected: [PRINT],
      },
      {
        steps: [
          {
            stdout: shipItPrint({ state: "not running", activeCount: 1, lastExitCode: 0, runs: 1 }),
          },
        ],
        expected: [PRINT],
      },
    ];

    for (const scenario of cases) {
      yield* run(scenario);
    }
  }),
);

it.effect("drops a ShipIt job only once it has finished exiting after the app is ready", () =>
  Effect.gen(function* () {
    const running = shipItPrint({
      state: "running",
      pid: 64038,
      activeCount: 1,
      lastExitCode: 0,
      runs: 1,
    });
    const cases = [
      {
        steps: [{ stdout: running }, { stdout: idlePrint }, { exitCode: 0 }],
        expected: [PRINT, PRINT, REMOVE],
      },
      { steps: [{ stdout: running }, { stdout: running }], expected: [PRINT, PRINT] },
    ];

    for (const scenario of cases) {
      const fiber = yield* run(scenario).pipe(Effect.forkChild);
      // Matches SHIPIT_EXIT_GRACE. A shorter adjust leaves the fiber asleep.
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
    }
  }),
);
