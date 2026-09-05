import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import type { IdAllocatorV2, IdAllocatorV2Error } from "./IdAllocator.ts";
import { applyToProjection } from "./ProjectionStore.ts";

export interface ThreadDeletionPlan {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
}

/** Plan the same durable cleanup for direct thread deletion and project removal. */
export const planThreadDeletion = Effect.fn("ThreadDeletion.planThreadDeletion")(function* (input: {
  readonly command: Extract<OrchestrationV2Command, { readonly type: "thread.delete" }>;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocatorV2["Service"];
}): Effect.fn.Return<ThreadDeletionPlan, IdAllocatorV2Error> {
  const { command, projection, now, idAllocator } = input;
  const events: Array<OrchestrationV2DomainEvent> = [];
  const effects: Array<PendingOrchestrationEffectV2> = [];
  let current = projection;
  const emitEvent = Effect.fn("ThreadDeletion.emitEvent")(function* <
    Event extends OrchestrationV2DomainEvent,
  >(event: Omit<Event, "id">) {
    const id = yield* idAllocator.allocate.event({
      threadId: event.threadId,
      commandId: command.commandId,
    });
    const withId = { ...event, id } as Event;
    events.push(withId);
    current = applyToProjection(current, withId);
  });

  yield* emitEvent({
    type: "thread.deleted",
    threadId: command.threadId,
    providerInstanceId: projection.thread.providerInstanceId,
    occurredAt: now,
    payload: {
      ...projection.thread,
      deletedAt: projection.thread.deletedAt ?? now,
      titleRegeneration: null,
      updatedAt: now,
    },
  });

  const activeRuns = projection.runs.filter((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );
  const activeRunById = new Map(activeRuns.map((run) => [run.id, run]));
  for (const run of activeRuns) {
    yield* emitEvent({
      type: "run.updated",
      threadId: command.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
    });
  }
  for (const attempt of projection.attempts) {
    const run = activeRunById.get(attempt.runId);
    if (run === undefined || (attempt.status !== "pending" && attempt.status !== "running")) {
      continue;
    }
    yield* emitEvent({
      type: "run-attempt.updated",
      threadId: command.threadId,
      runId: attempt.runId,
      nodeId: attempt.rootNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...attempt, status: "cancelled", completedAt: now },
    });
  }
  for (const node of projection.nodes) {
    const run = node.runId === null ? undefined : activeRunById.get(node.runId);
    if (run === undefined || !["pending", "running", "waiting"].includes(node.status)) {
      continue;
    }
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: run.id,
      nodeId: node.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: { ...node, status: "cancelled", completedAt: now },
    });
  }
  for (const request of projection.runtimeRequests.filter(
    (request) => request.status === "pending",
  )) {
    yield* emitEvent({
      type: "runtime-request.updated",
      threadId: command.threadId,
      nodeId: request.nodeId,
      occurredAt: now,
      payload: {
        ...request,
        status: "cancelled",
        responseCapability: { type: "not_resumable", reason: "The thread was deleted." },
        resolvedAt: now,
      },
    });
  }

  const cohortRunIds = new Set([
    ...current.runs.filter((run) => run.delegatedCompletion !== undefined).map((run) => run.id),
    ...current.subagents
      .filter((task) => task.origin === "app_owned" && task.runId !== null)
      .map((task) => task.runId!),
  ]);
  for (const parentRunId of cohortRunIds) {
    // Use the projected cancellation so disposing a cohort cannot revive its run.
    const parentRun = current.runs.find((run) => run.id === parentRunId);
    if (parentRun === undefined) continue;
    const cohort = parentRun.delegatedCompletion;
    const tasks = current.subagents.filter(
      (task) => task.origin === "app_owned" && task.runId === parentRunId,
    );
    yield* emitEvent({
      type: "run.updated",
      threadId: parentRun.threadId,
      runId: parentRun.id,
      ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...parentRun,
        delegatedCompletion: {
          disposition: "disposed",
          nextGeneration: cohort?.nextGeneration ?? 1,
          settledDeliveryCount: cohort?.settledDeliveryCount ?? 0,
          delivery: null,
        },
      },
    });
    for (const task of tasks) {
      if (
        task.completionDelivery?.state === "acknowledged" ||
        task.completionDelivery?.state === "delivered" ||
        task.completionDelivery?.state === "disposed"
      ) {
        continue;
      }
      yield* emitEvent({
        type: "subagent.updated",
        threadId: parentRun.threadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: {
          ...task,
          completionDelivery: { state: "disposed", observedByRunId: null },
          updatedAt: now,
        },
      });
    }
  }

  for (const session of projection.providerSessions) {
    if (session.status === "stopped" || session.status === "error") continue;
    yield* emitEvent({
      type: "provider-session.detached",
      threadId: command.threadId,
      driver: session.driver,
      providerInstanceId: session.providerInstanceId,
      occurredAt: now,
      payload: {
        providerSessionId: session.id,
        detachedAt: now,
        reason: "Thread deleted.",
      },
    });
    effects.push({
      id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: {
        type: "provider-session.detach",
        providerSessionId: session.id,
        detail: "Thread deleted.",
        revokeMcpCredential: true,
      },
    });
  }
  effects.push({
    id: `effect:${command.commandId}:terminal.cleanup`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: { type: "terminal.cleanup" },
  });
  const attachmentIds = Array.from(
    new Set(projection.messages.flatMap((message) => message.attachments.map((item) => item.id))),
  );
  if (attachmentIds.length > 0) {
    effects.push({
      id: `effect:${command.commandId}:attachment.cleanup`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: { type: "attachment.cleanup", attachmentIds },
    });
  }
  return { events, effects };
});
