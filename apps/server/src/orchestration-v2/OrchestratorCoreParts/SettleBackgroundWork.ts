import { type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, type OrchestrationV2ProviderThread, type OrchestrationV2ThreadProjection, type OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { endOrphanedNativeSubagent, endRunlessRootTurns } from "@t3tools/provider-core/server/subagentProjection";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart;

export const installSettleBackgroundWork = Effect.fnUntraced(function* (deps: Deps) {
  const { emit, idAllocator, projectionStore, providerSessions } = deps;

const settleBackgroundWork = Effect.fn("Orchestrator.settleBackgroundWork")(function* (input: {
  readonly command: Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "run.interrupt" | "thread.background-work.settle" }
  >;
  readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "nodes" | "subagents" | "turnItems" | "providerThreads"
  >;
  readonly stoppedProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
  readonly throughRunOrdinal: number;
  readonly now: DateTime.Utc;
}) {
  const emitEvent = emit(input.events, input.command);
  const runOrdinals = new Map(input.projection.runs.map((run) => [run.id, run.ordinal]));
  const allocateEventId = () =>
    idAllocator.allocate.event({
      threadId: input.command.threadId,
      commandId: input.command.commandId,
    });
  const childThreadIds = new Set<ThreadId>();
  const liveness = new Map<string, boolean>();
  const hasLiveSession = Effect.fn("Orchestrator.hasLiveSession")(function* (
    providerThreadId: OrchestrationV2ProviderThread["id"],
  ) {
    const known = liveness.get(providerThreadId);
    if (known !== undefined) return known;
    const sessionId = input.projection.providerThreads.find(
      (candidate) => candidate.id === providerThreadId,
    )?.providerSessionId;
    const live =
      sessionId !== null &&
      sessionId !== undefined &&
      Option.isSome(
        yield* providerSessions.get(sessionId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
    liveness.set(providerThreadId, live);
    return live;
  });
  const stillReportsBackgroundWork = Effect.fnUntraced(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    if (providerThread.providerSessionId == null) return false;
    const session = yield* providerSessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session) || session.value.hasPendingBackgroundWorkForThread === undefined) {
      return false;
    }
    return yield* session.value
      .hasPendingBackgroundWorkForThread(providerThread)
      // A failed probe cannot confirm that the work ended.
      .pipe(Effect.catchCause(() => Effect.succeed(true)));
  });
  for (const item of pendingBackgroundTurnItems({
    turnItems: input.projection.turnItems,
    runs: input.projection.runs,
  })) {
    const itemRunOrdinal = item.runId === null ? undefined : runOrdinals.get(item.runId);
    if (itemRunOrdinal !== undefined && itemRunOrdinal > input.throughRunOrdinal) continue;
    const providerThreadId = item.providerThreadId ?? null;
    if (
      providerThreadId !== null &&
      providerThreadId !== input.stoppedProviderThreadId &&
      (yield* hasLiveSession(providerThreadId))
    ) {
      continue;
    }
    const run = input.projection.runs.find((candidate) => candidate.id === item.runId);
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: input.command.threadId,
      ...(item.runId === null ? {} : { runId: item.runId }),
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      ...(run === undefined ? {} : { providerInstanceId: run.providerInstanceId }),
      occurredAt: input.now,
      payload: {
        ...item,
        status: "interrupted",
        completedAt: input.now,
        updatedAt: input.now,
      },
    });
    if (item.type !== "subagent") continue;
    // A native subagent died with the process too: end its record, its own
    // thread's runless root turn, and the subagents it started there, which
    // a provider can record on that thread rather than this one.
    const dying: Array<{
      readonly projection: Pick<
        OrchestrationV2ThreadProjection,
        "nodes" | "subagents" | "turnItems"
      >;
      readonly subagent: Pick<
        Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>,
        "subagentId" | "origin" | "childThreadId" | "providerInstanceId"
      >;
    }> = [{ projection: input.projection, subagent: item }];
    for (const { projection, subagent } of dying) {
      const ended = yield* endOrphanedNativeSubagent({
        projection,
        subagentId: subagent.subagentId,
        status: "interrupted",
        now: input.now,
        emitted: yield* Ref.get(input.events),
        allocateEventId,
      }).pipe(mapDispatchError(input.command));
      yield* Ref.update(input.events, (events) => [...events, ...ended]);
      const childThreadId = subagent.childThreadId;
      if (
        subagent.origin !== "provider_native" ||
        childThreadId === null ||
        childThreadIds.has(childThreadId)
      ) {
        continue;
      }
      childThreadIds.add(childThreadId);
      const child = yield* projectionStore
        .getThreadRecords(childThreadId, ["nodes", "providerTurns", "subagents", "turnItems"], {
          // Runless items are the subagent's; any run there is the user's own.
          turnItemRunIds: [null],
          turnItemStatuses: ["pending", "running", "waiting"],
        })
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          mapDispatchError(input.command),
        );
      if (child === null) continue;
      const childEnded = yield* endRunlessRootTurns({
        threadId: childThreadId,
        providerInstanceId: subagent.providerInstanceId,
        projection: child,
        status: "interrupted",
        now: input.now,
        emitted: yield* Ref.get(input.events),
        allocateEventId,
      }).pipe(mapDispatchError(input.command));
      yield* Ref.update(input.events, (events) => [...events, ...childEnded]);
      for (const nested of child.turnItems) {
        if (nested.type === "subagent") dying.push({ projection: child, subagent: nested });
      }
      for (const nested of child.subagents) {
        if (nested.origin === "provider_native" && nested.runId === null) {
          dying.push({
            projection: child,
            subagent: {
              subagentId: nested.id,
              origin: nested.origin,
              childThreadId: nested.childThreadId,
              providerInstanceId: nested.providerInstanceId,
            },
          });
        }
      }
    }
  }
  for (const providerThread of input.projection.providerThreads) {
    if ((providerThread.pendingBackgroundTasks?.length ?? 0) === 0) continue;
    if (providerThread.id === input.stoppedProviderThreadId) {
      // A refused newer start can take ownership and reject the stopped
      // turn's roster clear. Reconcile it without hiding surviving work.
      if (yield* stillReportsBackgroundWork(providerThread)) continue;
    } else if (yield* hasLiveSession(providerThread.id)) {
      continue;
    }
    yield* emitEvent({
      type: "provider-thread.updated",
      threadId: input.command.threadId,
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      occurredAt: input.now,
      payload: {
        ...providerThread,
        status:
          providerThread.status === "active" &&
          providerThread.lastRunOrdinal !== null &&
          providerThread.lastRunOrdinal <= input.throughRunOrdinal
            ? "idle"
            : providerThread.status,
        pendingBackgroundTasks: [],
        updatedAt: input.now,
      },
    });
  }
});

  return { settleBackgroundWork };
});

export type SettleBackgroundWorkPart = ReturnType<typeof installSettleBackgroundWork> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installSettleBackgroundWork>;
