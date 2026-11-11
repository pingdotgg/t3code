import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeTrackedRuns } from "./TrackedRuns.ts";

const taskId = ScheduledTaskId.make("task:tracked");
const threadId = ThreadId.make("thread:tracked");
const messageId = MessageId.make("message:tracked");
const epoch = DateTime.makeUnsafe(0);

const runEvent = (
  runId: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
  userMessageId = messageId,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${runId}:${status}`),
  type: "run.updated",
  threadId,
  runId: RunId.make(runId),
  occurredAt: epoch,
  payload: {
    id: RunId.make(runId),
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: epoch,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

const settledFor = (
  status: "succeeded" | "failed",
  error: string | null,
  cancelledRunId: string | null = null,
) => ({
  taskId,
  startedAtIso: "start",
  messageId,
  threadId,
  status,
  error,
  cancelledRunId: cancelledRunId === null ? null : RunId.make(cancelledRunId),
});

it("ends a queued run that was cancelled outright", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId, threadId);
  runs.observe(runEvent("run:queued", "queued"));
  runs.observe(runEvent("run:queued", "cancelled"));
  assert.isTrue(runs.confirmCancel(messageId, RunId.make("run:queued"), RunId.make("run:queued")));
  assert.isFalse(runs.confirmCancel(messageId, RunId.make("run:queued"), RunId.make("run:queued")));
});

it("lists only dispatched runs as pending, and follows a run bound from the projection", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  assert.deepEqual(runs.pending(), []);
  runs.dispatched(messageId, threadId);
  assert.deepEqual(runs.pending(), [
    { taskId, startedAtIso: "start", messageId, threadId, runId: null },
  ]);
  runs.bindRun(messageId, RunId.make("run:caught-up"), null);
  assert.deepEqual(runs.observe(runEvent("run:caught-up", "completed", MessageId.make("other"))), [
    settledFor("succeeded", null),
  ]);
  assert.deepEqual(runs.pending(), []);
});

it("fails a run whose thread is deleted before the turn ends", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId, threadId);
  runs.observe(runEvent("run:orphaned", "running"));
  assert.deepEqual(
    runs.observe({
      id: EventId.make("event:deleted"),
      type: "thread.deleted",
      threadId,
      occurredAt: epoch,
      payload: undefined as never,
    }),
    [settledFor("failed", "The thread was deleted.")],
  );
});

it("keeps a promoted message tracked when cancellation arrived before dispatch returned", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.observe(runEvent("run:queued", "queued"));
  runs.observe(runEvent("run:queued", "cancelled"));
  runs.bindRun(messageId, RunId.make("run:active"), RunId.make("run:queued"));
  const held = runs.dispatched(messageId, threadId);
  assert.equal(held?.cancelledRunId, "run:queued");
  assert.isFalse(runs.confirmCancel(messageId, RunId.make("run:queued"), RunId.make("run:active")));
  assert.deepEqual(runs.observe(runEvent("run:active", "completed")), [
    settledFor("succeeded", null),
  ]);
});

it("does not let a stale catch-up overwrite a live promotion", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId, threadId);
  runs.observe(runEvent("run:queued", "queued"));
  const queuedRunId = RunId.make("run:queued");
  runs.observe(runEvent("run:queued", "cancelled"));
  runs.confirmCancel(messageId, queuedRunId, RunId.make("run:active"));
  assert.isFalse(runs.bindRun(messageId, queuedRunId, queuedRunId));
  assert.deepEqual(runs.observe(runEvent("run:active", "completed")), [
    settledFor("succeeded", null),
  ]);
});

it("ignores a stale cancellation read after a live promotion", () => {
  const runs = makeTrackedRuns();
  runs.track(messageId, taskId, "start");
  runs.dispatched(messageId, threadId);
  runs.observe(runEvent("run:queued", "queued"));
  const queuedRunId = RunId.make("run:queued");
  runs.confirmCancel(messageId, queuedRunId, RunId.make("run:active"));
  assert.isFalse(runs.confirmCancel(messageId, queuedRunId, queuedRunId));
  assert.deepEqual(runs.observe(runEvent("run:active", "completed")), [
    settledFor("succeeded", null),
  ]);
});
