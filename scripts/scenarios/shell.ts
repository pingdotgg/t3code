import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ScenarioError extends Schema.TaggedError<ScenarioError>()("ScenarioError", {
  message: Schema.String,
}) {}

interface RunOptions {
  readonly cwd?: string;
  /** Replaces the inherited environment when given. */
  readonly env?: NodeJS.ProcessEnv;
  /** Exit codes that are answers, not failures. Defaults to 0 only. */
  readonly allowExit?: ReadonlyArray<number>;
  /** Prints the command's output to stderr as it arrives, keeping stdout for results. */
  readonly echo?: boolean;
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>, echo: boolean) =>
  echo
    ? stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.tap((line) => Console.error(line)),
        Stream.runCollect,
        Effect.map((lines) => [...lines].join("\n")),
      )
    : Stream.mkString(Stream.decodeText(stream));

/** Runs a command to its end and returns what it printed. */
export const run = Effect.fn("scenario.run")(
  function* (program: string, args: ReadonlyArray<string>, options: RunOptions = {}) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(program, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env, extendEnv: false }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collect(child.stdout, options.echo === true),
        collect(child.stderr, options.echo === true),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (!(options.allowExit ?? [0]).includes(exitCode)) {
      return yield* new ScenarioError({
        message: `${program} ${args.slice(0, 3).join(" ")} exited with ${exitCode}: ${stderr.trim().slice(-600)}`,
      });
    }
    return { stdout, stderr, exitCode: Number(exitCode) };
  },
  Effect.scoped,
  Effect.mapError((error) =>
    error._tag === "ScenarioError" ? error : new ScenarioError({ message: String(error) }),
  ),
);
