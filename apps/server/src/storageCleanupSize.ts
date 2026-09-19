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
  {
    path: Schema.String,
    stage: Schema.Literals(["resolve", "spawn", "request", "response", "scan", "exit"]),
    reason: Schema.Literals(["failed", "invalid-response", "premature-exit", "nonzero-exit"]),
    exitCode: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Worktree measurement ${this.stage}: ${this.reason}`;
  }
}

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
        const executable = yield* binary.resolve.pipe(
          Effect.mapError(
            (cause) =>
              new WorktreeMeasurementError({
                path: root,
                stage: "resolve",
                reason: "failed",
                cause,
              }),
          ),
        );
        const child = yield* Effect.acquireRelease(
          spawner
            .spawn(
              ChildProcess.make(executable, ["--storage-scan", root], {
                stdin: { stream: "pipe", endOnDone: false },
                stdout: "pipe",
                stderr: "ignore",
                forceKillAfter: "2 seconds",
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorktreeMeasurementError({
                    path: root,
                    stage: "spawn",
                    reason: "failed",
                    cause,
                  }),
              ),
            ),
          (handle) => handle.kill().pipe(Effect.ignore),
        );
        const read = yield* Stream.toPull(
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line !== ""),
            Stream.mapError(
              (cause) =>
                new WorktreeMeasurementError({
                  path: root,
                  stage: "response",
                  reason: "failed",
                  cause,
                }),
            ),
            Stream.mapEffect((line) =>
              decodeEvent(line).pipe(
                Effect.mapError(
                  (cause) =>
                    new WorktreeMeasurementError({
                      path: root,
                      stage: "response",
                      reason: "invalid-response",
                      cause,
                    }),
                ),
              ),
            ),
          ),
        );
        // Request only when downstream pulls: a paused scan keeps its native cursor,
        // while closing the stream terminates the child and releases its handles.
        return Stream.paginate(undefined, () =>
          Effect.gen(function* () {
            yield* Stream.run(Stream.encodeText(Stream.make("next\n")), child.stdin).pipe(
              Effect.mapError(
                (cause) =>
                  new WorktreeMeasurementError({
                    path: root,
                    stage: "request",
                    reason: "failed",
                    cause,
                  }),
              ),
            );
            const events = yield* read.pipe(
              Pull.catchDone(() =>
                Effect.fail(
                  new WorktreeMeasurementError({
                    path: root,
                    stage: "response",
                    reason: "premature-exit",
                  }),
                ),
              ),
              Effect.timeout("30 seconds"),
              Effect.catchTags({
                TimeoutError: (cause) =>
                  Effect.fail(
                    new WorktreeMeasurementError({
                      path: root,
                      stage: "response",
                      reason: "failed",
                      cause,
                    }),
                  ),
              }),
            );
            if (events.length !== 1)
              return yield* Effect.fail(
                new WorktreeMeasurementError({
                  path: root,
                  stage: "response",
                  reason: "invalid-response",
                }),
              );
            const event = events[0];
            if ("error" in event)
              return yield* Effect.fail(
                new WorktreeMeasurementError({
                  path: root,
                  stage: "scan",
                  reason: "failed",
                  cause: event.error,
                }),
              );
            if (event.done) {
              const exitCode = yield* child.exitCode.pipe(
                Effect.timeout("2 seconds"),
                Effect.mapError(
                  (cause) =>
                    new WorktreeMeasurementError({
                      path: root,
                      stage: "exit",
                      reason: "failed",
                      cause,
                    }),
                ),
              );
              if (exitCode !== 0)
                return yield* Effect.fail(
                  new WorktreeMeasurementError({
                    path: root,
                    stage: "exit",
                    reason: "nonzero-exit",
                    exitCode,
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
    );
  return WorktreeSize.of({ measure });
});

export const layer = Layer.effect(WorktreeSize, make);
