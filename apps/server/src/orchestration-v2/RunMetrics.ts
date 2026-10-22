import type {
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  metricAttributes,
  runDuration,
  runQueueWait,
  runsTotal,
} from "../observability/Metrics.ts";

const REMEMBERED_RUNS = 4096;
// A rollback rewrites runs that already finished, stamping the rollback time as their completion,
// so it is not counted as an outcome. Declared here because ThreadManagementService imports
// EventSink.
const OUTCOMES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface RunOutcome {
  readonly runId: RunId;
  readonly attributes: ReturnType<typeof metricAttributes>;
  readonly queueWait: Duration.Duration | undefined;
  readonly duration: Duration.Duration | undefined;
}

/**
 * Records each run once, when a committed event first shows it finished. A finished run's row is
 * updated again later (its checkpoint, a settlement), so recently counted runs are remembered.
 *
 * A run carries `delegatedTaskId` only when a follow-up is associated with a task, so a subagent
 * thread's first run is recognized by its thread's lineage instead. A failed lookup only costs the
 * label: the events still commit and publish.
 *
 * `prepare` reads lineage, so the EventSink runs it inside the write transaction, on the
 * connection that transaction already holds. `record` runs after the commit, under the publish
 * lane, and must stay free of I/O: a read there waits for the writer connection while holding the
 * lane, and the next writer holds that connection while it waits for the lane.
 */
export const makeRunOutcomeRecorder = <E>(
  isSubagentThread: (threadId: ThreadId) => Effect.Effect<boolean, E>,
) => {
  const counted = new Set<string>();
  // Untraced: both run for every committed batch inside the EventSink operation's span.
  // Never reads or writes `counted`, so a transaction that rolls back reserves nothing.
  const prepare = Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
    const outcomes: Array<RunOutcome> = [];
    // Every finished run is prepared, in order, even one already counted: an earlier outcome in
    // this batch may evict it before `record` reaches it, so only `record` decides what counts.
    // Only the lineage read is shared.
    const delegatedThreads = new Map<ThreadId, boolean>();
    for (const { event } of events) {
      if (event.type !== "run.updated") continue;
      const run = event.payload;
      if (!OUTCOMES.has(run.status)) continue;
      let delegated = run.delegatedTaskId !== undefined || delegatedThreads.get(run.threadId);
      if (delegated === undefined) {
        delegated = yield* isSubagentThread(run.threadId).pipe(Effect.orElseSucceed(() => false));
        delegatedThreads.set(run.threadId, delegated);
      }
      outcomes.push({
        runId: run.id,
        attributes: metricAttributes({
          provider: run.providerInstanceId,
          modelFamily: normalizeModelMetricLabel(run.modelSelection.model),
          outcome: run.status,
          delegated,
        }),
        queueWait:
          run.startedAt === null ? undefined : DateTime.distance(run.requestedAt, run.startedAt),
        duration:
          run.startedAt === null || run.completedAt === null
            ? undefined
            : DateTime.distance(run.startedAt, run.completedAt),
      });
    }
    return outcomes;
  });
  // Uninterruptible so a run is never marked counted with only part of its measurements.
  const record = Effect.fnUntraced(function* (outcomes: ReadonlyArray<RunOutcome>) {
    for (const outcome of outcomes) {
      // Concurrent writers can prepare the same run; the first to publish counts it.
      if (counted.has(outcome.runId)) continue;
      counted.add(outcome.runId);
      if (counted.size > REMEMBERED_RUNS) counted.delete(counted.values().next().value!);
      yield* Metric.update(Metric.withAttributes(runsTotal, outcome.attributes), 1);
      if (outcome.queueWait !== undefined) {
        yield* Metric.update(
          Metric.withAttributes(runQueueWait, outcome.attributes),
          outcome.queueWait,
        );
      }
      if (outcome.duration !== undefined) {
        yield* Metric.update(
          Metric.withAttributes(runDuration, outcome.attributes),
          outcome.duration,
        );
      }
    }
  }, Effect.uninterruptible);
  return { prepare, record };
};
