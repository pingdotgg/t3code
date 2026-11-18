import { UsageBudgetError, UsageBudgetStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageBudgetStatus));

const STDERR_DETAIL_LIMIT = 500;

/** Run the usage budget command and decode its status; an empty command means no budget is set up. */
export const readUsageBudget = Effect.fn("readUsageBudget")(function* (
  command: ReadonlyArray<string>,
) {
  const [program, ...args] = command;
  if (program === undefined) return null;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { stdout, stderr, exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(program, args, { stdin: "ignore" }));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(
      (cause) => new UsageBudgetError({ detail: `${program} did not finish`, cause }),
    ),
  );
  if (exitCode !== 0) {
    const reason = stderr.trim().slice(0, STDERR_DETAIL_LIMIT);
    return yield* new UsageBudgetError({
      detail: `${program} exited with ${exitCode}${reason === "" ? "" : `: ${reason}`}`,
    });
  }
  return yield* decodeStatus(stdout).pipe(
    Effect.mapError(
      (cause) => new UsageBudgetError({ detail: `${program} printed an unknown status`, cause }),
    ),
  );
});
