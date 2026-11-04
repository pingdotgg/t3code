/**
 * Drives one example through the real CLI lifecycle: `alchemy dev` until the
 * run converges, then `alchemy deploy` (unless `--dev-only`), and always
 * `alchemy destroy` afterwards.
 *
 * Usage: node scripts/test-example-cli.ts <example-directory> [--dev-only]
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import { Argument, Command, Flag } from "effect/cli";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";

/** A lifecycle step failed; `message` carries the CLI output. */
class StepFailed extends Data.TaggedError("StepFailed")<{ readonly message: string }> {
  readonly [Runtime.errorReported] = false;
}

type StepName = "dev" | "deploy" | "destroy";

type CommandResult = {
  readonly exitCode: number | null;
  readonly output: string;
};

const stage = "cli-example-test";
// The summary line the CLI prints once a run converges. In non-TTY mode every
// line carries a `[time] LEVEL (#fiber): ` prefix, so anchor on the text.
const DONE = /Done: \d+ succeeded/;
const timeoutMs = 4 * 60_000;

const command = Command.make(
  "test-example-cli",
  {
    example: Argument.String("example-directory").pipe(
      Argument.withDescription("Example directory, relative to the repository root"),
    ),
    devOnly: Flag.Boolean("dev-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Skip `alchemy deploy`; run only dev and destroy"),
    ),
  },
  Effect.fn(function* ({ example, devOnly }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;

    const repositoryRoot = path.resolve(import.meta.dirname, "..");
    const exampleRoot = path.resolve(repositoryRoot, example);
    // The real launcher, not `bin/alchemy.js`: it pins bun's tsconfig to
    // alchemy's own, so the CLI's .tsx files are not transpiled with the
    // example's JSX settings (solid-js examples otherwise crash the CLI).
    const alchemyBin = path.join(repositoryRoot, "packages", "alchemy", "bin", "cli.js");
    const debug = (yield* Config.String("DEBUG").pipe(Config.withDefault(""))) !== "";

    // With a profile (`test:examples --profile testing`) the CLI must see the
    // real ALCHEMY_HOME (where the profile's credentials live) and must NOT run
    // as CI, which makes auth resolution skip profiles for env credentials.
    // Without a profile, run against an empty home as CI so the CLI can only
    // authenticate from env vars, the way a fresh CI runner would.
    const profile = yield* Config.String("ALCHEMY_PROFILE").pipe(Config.option);
    const alchemyHome =
      profile._tag === "None"
        ? yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-example-cli-" })
        : undefined;
    const childEnv = {
      ...(alchemyHome === undefined
        ? {}
        : { ALCHEMY_HOME: alchemyHome, AWS_PROFILE: undefined, CI: "true" }),
      NO_COLOR: "1",
    };

    /**
     * Spawns `alchemy <name>` in its own process group and collects its
     * output. `onOutput` sees the output so far and may stop the CLI early.
     * Interrupting (Ctrl-C) sends SIGINT to the group and waits for it.
     */
    const runCli = (
      name: StepName,
      /** Returns a signal to stop the CLI's process group early. */
      onOutput: (output: string) => "SIGINT" | "SIGKILL" | undefined,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(
              "bun",
              [
                alchemyBin,
                name,
                "--stage",
                stage,
                "--no-input",
                ...(name === "dev" ? [] : ["--yes"]),
              ],
              {
                cwd: exampleRoot,
                detached: true,
                env: childEnv,
                extendEnv: true,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                killSignal: "SIGINT",
                forceKillAfter: "15 seconds",
              },
            ),
          );
          let output = "";
          const kill = (signal: "SIGINT" | "SIGKILL") =>
            child
              .kill(
                signal === "SIGINT"
                  ? { killSignal: "SIGINT", forceKillAfter: "15 seconds" }
                  : { killSignal: "SIGKILL" },
              )
              .pipe(Effect.ignore, Effect.forkScoped);
          yield* child.all.pipe(
            Stream.decodeText,
            Stream.runForEach(
              Effect.fnUntraced(function* (text) {
                output += text;
                if (debug) yield* Effect.sync(() => process.stderr.write(text));
                const signal = onOutput(output);
                if (signal !== undefined) yield* kill(signal);
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
          const exitCode = yield* child.exitCode.pipe(
            Effect.map((code): number | null => code),
            // Terminated by a signal.
            Effect.orElseSucceed(() => null),
            Effect.timeoutOption(timeoutMs),
          );
          if (exitCode._tag === "Some") return { exitCode: exitCode.value, output };
          output += `\nTimed out after ${timeoutMs / 1000}s waiting for alchemy ${name}${name === "dev" ? " to become ready" : ""}.`;
          yield* kill("SIGKILL");
          const code = yield* child.exitCode.pipe(Effect.orElseSucceed(() => null));
          return { exitCode: code, output } satisfies CommandResult;
        }),
      );

    const run = (name: "deploy" | "destroy") => runCli(name, () => undefined);

    const runDev = Effect.suspend(() => {
      let ready = false;
      return runCli("dev", (output) => {
        if (ready) return undefined;
        if (DONE.test(output) && /https?:\/\//.test(output)) {
          ready = true;
          return "SIGINT";
        }
        // A failed run leaves `dev` waiting for a file change that never
        // comes; fail now instead of at the timeout.
        if (output.includes("alchemy dev: run failed")) return "SIGKILL";
        return undefined;
      }).pipe(
        Effect.map((result): CommandResult =>
          ready ? { exitCode: 0, output: result.output } : result,
        ),
      );
    });

    const assertSuccess = (name: StepName, result: CommandResult) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new StepFailed({
              message: `${example}: alchemy ${name} failed (exit ${result.exitCode ?? "signal"})\n${result.output}`,
            }),
          );

    const assertOutput = (name: StepName, result: CommandResult, expected: readonly RegExp[]) => {
      const missing = expected.find((pattern) => !pattern.test(result.output));
      return missing === undefined
        ? Effect.void
        : Effect.fail(
            new StepFailed({
              message: `${example}: alchemy ${name} output did not match ${missing}\n${result.output}`,
            }),
          );
    };

    // Not a finalizer: on Ctrl-C the CLI shuts down and this script exits
    // without starting destroy, like the interrupted run it follows.
    const primary = yield* Effect.exit(
      Effect.gen(function* () {
        const dev = yield* runDev;
        yield* assertSuccess("dev", dev);
        yield* assertOutput("dev", dev, [new RegExp(`Dev · ${stage}`), DONE, /https?:\/\//]);

        if (!devOnly) {
          const deployed = yield* run("deploy");
          yield* assertSuccess("deploy", deployed);
          yield* assertOutput("deploy", deployed, [
            new RegExp(`Deploy · ${stage}`),
            DONE,
            /https?:\/\//,
          ]);
        }
      }),
    );

    const destroyed = yield* Effect.exit(run("destroy"));
    let failure = Exit.isFailure(primary) ? primary.cause : undefined;
    if (Exit.isFailure(destroyed)) {
      if (failure === undefined) failure = destroyed.cause;
      else
        yield* Console.error(
          `${example}: cleanup destroy failed\n${Cause.pretty(destroyed.cause)}`,
        );
    } else if (destroyed.value.exitCode !== 0 && failure === undefined) {
      failure = Cause.fail(
        new StepFailed({
          message: `${example}: alchemy destroy failed (exit ${destroyed.value.exitCode ?? "signal"})\n${destroyed.value.output}`,
        }),
      );
    } else if (destroyed.value.exitCode !== 0) {
      yield* Console.error(`${example}: cleanup destroy also failed\n${destroyed.value.output}`);
    } else if (failure === undefined) {
      const matched = yield* Effect.exit(
        assertOutput("destroy", destroyed.value, [new RegExp(`Destroy · ${stage}`), DONE]),
      );
      if (Exit.isFailure(matched)) failure = matched.cause;
    }

    if (failure !== undefined) {
      const error = Cause.squash(failure);
      const message = error instanceof StepFailed ? error.message : Cause.pretty(failure);
      yield* Console.error(message);
      return yield* new StepFailed({ message });
    }
  }, Effect.scoped),
).pipe(Command.withDescription("Run an example through alchemy dev, deploy and destroy"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
