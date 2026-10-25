import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Label = Schema.String.check(Schema.isMaxLength(256));
const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const Summary = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  recordedAt: Count,
  host: Label,
  platform: Label,
  arch: Label,
  ci: Schema.Boolean,
  runId: Label,
  tasks: Schema.Array(
    Schema.Struct({
      package: Label,
      task: Label,
      source: Schema.Literals(["local", "remote", "unspecified", "executed", "failed"]),
      savedMs: Count,
    }),
  ).check(Schema.isMaxLength(1000)),
});

export const recordSummary = Effect.fn("TaskCache.summary")(function* (
  summary: typeof Summary.Type,
  developer: string,
) {
  const local = summary.tasks.filter((task) => task.source === "local");
  const unspecified = summary.tasks.filter((task) => task.source === "unspecified");
  const remote = summary.tasks.filter((task) => task.source === "remote");
  yield* Effect.annotateCurrentSpan({
    "cache.event_id": summary.id,
    "cache.recorded_at": summary.recordedAt,
    "developer.id": developer,
    "host.name": summary.host,
    "host.os": summary.platform,
    "host.arch": summary.arch,
    ci: summary.ci,
    "ci.run_id": summary.runId,
    "cache.local_hits": local.length,
    "cache.unspecified_hits": unspecified.length,
    "cache.unspecified_saved_ms": unspecified.reduce((sum, task) => sum + task.savedMs, 0),
    "cache.remote_hits": remote.length,
    "cache.executed": summary.tasks.filter((task) => task.source === "executed").length,
    "cache.restore_failures": summary.tasks.filter((task) => task.source === "failed").length,
    "cache.local_saved_ms": local.reduce((sum, task) => sum + task.savedMs, 0),
    "cache.remote_saved_ms": remote.reduce((sum, task) => sum + task.savedMs, 0),
  });
  yield* Effect.forEach(summary.tasks, (task, index) =>
    Effect.annotateCurrentSpan({
      "cache.event_id": summary.id,
      "cache.task_index": index,
      "developer.id": developer,
      "host.name": summary.host,
      "task.package": task.package,
      "task.name": task.task,
      "cache.source": task.source,
      "cache.saved_ms": task.savedMs,
    }).pipe(Effect.withSpan("TaskCache.task")),
  );
});
