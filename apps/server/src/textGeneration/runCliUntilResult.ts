import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { normalizeCliError } from "@t3tools/provider-core/server/textGenerationUtils";

// Provider CLIs flush telemetry for up to ~1.5 s after printing their result.
const EXIT_GRACE = "10 seconds";

export type CliRun<A> =
  | { readonly _tag: "Result"; readonly result: A }
  | {
      readonly _tag: "Exited";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    };

/**
 * Runs a CLI until `readResult` finds its result in stdout, or until it exits.
 * After an early result the process, and whatever `command` acquired, stays alive in the
 * background until it exits or the grace period ends.
 */
export const runCliUntilResult = Effect.fn("runCliUntilResult")(function* <A, E, R>(input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cliName: string;
  readonly label: string;
  readonly operation: string;
  readonly command: Effect.Effect<ChildProcess.Command, E, R>;
  /** Called with each stdout chunk in order; a value ends the run. */
  readonly readResult: (chunk: string) => A | undefined;
}) {
  const processScope = yield* Scope.make();
  let detached = false;
  const collect = <E2>(stream: Stream.Stream<Uint8Array, E2>, onChunk?: (chunk: string) => void) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => {
          onChunk?.(chunk);
          return acc + chunk;
        },
      ),
      Effect.mapError((cause) =>
        normalizeCliError(
          input.cliName,
          input.operation,
          cause,
          "Failed to collect process output",
        ),
      ),
    );

  return yield* Effect.gen(function* () {
    const command = yield* input.command;
    const child = yield* input.spawner
      .spawn(command)
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError(
            input.cliName,
            input.operation,
            cause,
            `Failed to spawn ${input.label} CLI process`,
          ),
        ),
      );
    const found = yield* Deferred.make<A>();
    let searching = true;
    const exited = yield* Effect.all(
      [
        collect(child.stdout, (chunk) => {
          if (!searching) return;
          const result = input.readResult(chunk);
          if (result === undefined) return;
          searching = false;
          Deferred.doneUnsafe(found, Exit.succeed(result));
        }),
        collect(child.stderr),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              input.cliName,
              input.operation,
              cause,
              `Failed to read ${input.label} CLI exit code`,
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([stdout, stderr, exitCode]): CliRun<A> => ({
        _tag: "Exited",
        stdout,
        stderr,
        exitCode,
      })),
      Effect.forkScoped,
    );
    const run = yield* Effect.raceFirst(
      Deferred.await(found).pipe(Effect.map((result): CliRun<A> => ({ _tag: "Result", result }))),
      Fiber.join(exited),
    );
    if (run._tag === "Result") {
      yield* Fiber.await(exited).pipe(
        Effect.timeoutOption(EXIT_GRACE),
        Effect.ensuring(Scope.close(processScope, Exit.void)),
        Effect.forkDetach,
      );
      detached = true;
    }
    return run;
  }).pipe(
    Scope.provide(processScope),
    Effect.onExit((exit) => (detached ? Effect.void : Scope.close(processScope, exit))),
  );
});
