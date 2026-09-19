import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Pull from "effect/Pull";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ResourceMonitorBinary } from "./resourceTelemetry/ResourceMonitorBinary.ts";

export class WorktreeMeasurementError extends Schema.TaggedError<WorktreeMeasurementError>()(
  "WorktreeMeasurementError",
  { cause: Schema.Defect() },
) {}

const isWorktreeMeasurementError = Schema.is(WorktreeMeasurementError);

const Progress = Schema.Struct({
  version: Schema.Literal(1),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  done: Schema.Boolean,
});
const decodeEvent = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Union([Progress, Schema.Struct({ version: Schema.Literal(1), error: Schema.String })]),
  ),
);

export class WorktreeSize extends Context.Service<
  WorktreeSize,
  {
    readonly measure: (
      root: string,
    ) => Stream.Stream<
      { readonly bytes: number; readonly done: boolean },
      WorktreeMeasurementError
    >;
  }
>()("t3/storageCleanupSize/WorktreeSize") {}

export const make = Effect.gen(function* () {
  const binary = yield* ResourceMonitorBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const measure: WorktreeSize["Service"]["measure"] = (root) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const executable = yield* binary.resolve;
        const child = yield* Effect.acquireRelease(
          spawner.spawn(
            ChildProcess.make(executable, ["--storage-scan", root], {
              stdin: { stream: "pipe", endOnDone: false },
              stdout: "pipe",
              stderr: "ignore",
              forceKillAfter: "2 seconds",
            }),
          ),
          (handle) => handle.kill().pipe(Effect.ignore),
        );
        const read = yield* Stream.toPull(
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line !== ""),
            Stream.mapEffect((line) => decodeEvent(line)),
          ),
        );
        // Request only when downstream pulls: a paused scan keeps its native cursor,
        // while closing the stream terminates the child and releases its handles.
        return Stream.paginate(undefined, () =>
          Effect.gen(function* () {
            yield* Stream.run(Stream.encodeText(Stream.make("next\n")), child.stdin);
            const events = yield* read.pipe(
              Pull.catchDone(() =>
                Effect.fail(
                  new WorktreeMeasurementError({
                    cause: "Native storage scanner exited before completion",
                  }),
                ),
              ),
              Effect.timeout("30 seconds"),
            );
            if (events.length !== 1)
              return yield* Effect.fail(
                new WorktreeMeasurementError({ cause: "Unexpected storage scan response" }),
              );
            const event = events[0];
            if ("error" in event)
              return yield* Effect.fail(new WorktreeMeasurementError({ cause: event.error }));
            if (event.done) {
              const exitCode = yield* child.exitCode.pipe(Effect.timeout("2 seconds"));
              if (exitCode !== 0)
                return yield* Effect.fail(
                  new WorktreeMeasurementError({
                    cause: `Native storage scanner exited with ${exitCode}`,
                  }),
                );
            }
            return [
              [{ bytes: event.bytes, done: event.done }],
              event.done ? Option.none() : Option.some(undefined),
            ] as const;
          }),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isWorktreeMeasurementError(cause) ? cause : new WorktreeMeasurementError({ cause }),
      ),
    );
  return WorktreeSize.of({ measure });
});

export const layer = Layer.effect(WorktreeSize, make);
