import { CommandId, isProviderNativeSubagentThread, type OrchestrationV2ServerCommand, type OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { isActiveRun } from "../CommandPolicy.ts";
import { withoutGuestAttribution } from "../GuestShareDecider.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";
import { planThreadDeletion } from "../ThreadDeletion.ts";
import { OrchestratorDispatchError, OrchestratorProjectionError, OrchestratorSubagentThreadReadOnlyError } from "../orchestrationErrors.ts";
import { commandThreadId, usageLimitHoldsQueue } from "../orchestrationCommandQueries.ts";
import { delegatedTasksStopEffect, queuedRunModelSelection, type OrchestratorV2Error } from "../OrchestratorCorePrelude/OrchestratorV2Shape.ts";
import type { FailQueuedRunStartPart } from "./FailQueuedRunStart.ts";
import type { StartNextQueuedRunPart } from "./StartNextQueuedRun.ts";
import type { DispatchDelegatedTaskCompletionDeliveryResolutionPart } from "./DispatchDelegatedTaskCompletionDeliveryResolution.ts";
import type { RecordSubagentFollowupPart } from "./RecordSubagentFollowup.ts";
import type { DispatchSteerIntoRunPart } from "./DispatchSteerIntoRun.ts";
import type { SettleInterruptedRunPart } from "./SettleInterruptedRun.ts";
import type { SettleBackgroundWorkPart } from "./SettleBackgroundWork.ts";
import type { DispatchRunInterruptPart } from "./DispatchRunInterrupt.ts";
import type { DispatchRuntimeRequestRespondPart } from "./DispatchRuntimeRequestRespond.ts";
import type { DispatchThreadMergeBackPart } from "./DispatchThreadMergeBack.ts";
import type { DispatchDelegatedTaskRequestPart } from "./DispatchDelegatedTaskRequest.ts";
import type { DispatchRemoteDelegatedTaskCompletePart } from "./DispatchRemoteDelegatedTaskComplete.ts";
import type { DispatchSubagentStopPart } from "./DispatchSubagentStop.ts";
import type { FinalizeAppOwnedSubagentTaskPart } from "./FinalizeAppOwnedSubagentTask.ts";

type Deps = Record<never, never> & FailQueuedRunStartPart & StartNextQueuedRunPart & DispatchDelegatedTaskCompletionDeliveryResolutionPart & RecordSubagentFollowupPart & DispatchSteerIntoRunPart & SettleInterruptedRunPart & SettleBackgroundWorkPart & DispatchRunInterruptPart & DispatchRuntimeRequestRespondPart & DispatchThreadMergeBackPart & DispatchDelegatedTaskRequestPart & DispatchRemoteDelegatedTaskCompletePart & DispatchSubagentStopPart & FinalizeAppOwnedSubagentTaskPart;

export const installDispatchOnce = Effect.fnUntraced(function* (deps: Deps) {
  const { cancelIdleOrphans, dispatchBackgroundWorkSettle, dispatchCheckpointRollback, dispatchCheckpointRollbackFail, dispatchCreatedThreadRecord, dispatchDelegatedTaskCompletionDeliveryResolution, dispatchDelegatedTaskRequest, dispatchDelegatedTaskWakePolicy, dispatchGuestShare, dispatchInterruptUnresponsive, dispatchLinkRequestRecord, dispatchMessage, dispatchNotificationAccepted, dispatchPreparedRunFail, dispatchPreparedRunProgress, dispatchPreparedRunRelease, dispatchPreparedRunRetry, dispatchProviderSessionDetach, dispatchPullRequestWatchSync, dispatchQueuedMessagePromoteToSteer, dispatchQueuedRunCancel, dispatchQueuedRunEdit, dispatchQueuedRunReorder, dispatchRemoteDelegatedTaskComplete, dispatchRemoteDelegatedTaskRequest, dispatchRemoteDelegatedTaskStop, dispatchRunInterrupt, dispatchRuntimeRequestDeliveryFail, dispatchRuntimeRequestRespond, dispatchSecretRequestRecord, dispatchSubagentStop, dispatchThreadCreate, dispatchThreadFork, dispatchThreadMergeBack, dispatchThreadMutation, dispatchThreadProjectAdoptFolder, dispatchThreadStop, dispatchThreadUserInputDismiss, dispatchThreadVisit, dispatchUnsupported, emit, emitGuestMessageSent, idAllocator, loadProjectionForCommand, projectionStore, recordSubagentFollowup } = deps;

const dispatchOnce = Effect.fn("orchestrationV2.dispatch.once")(function* (
  command: OrchestrationV2ServerCommand,
  sideChatIds: ReadonlyArray<ThreadId>,
): Effect.fn.Return<
  {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
  },
  OrchestratorV2Error
> {
  yield* Effect.annotateCurrentSpan({
    "orchestration_v2.command_id": command.commandId,
    "orchestration_v2.command_type": command.type,
    "orchestration_v2.thread_id": commandThreadId(command),
  });

  const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
  const effects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
  let cancelUnsettledEffects:
    | {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      }
    | undefined;
  let updateDelegatedCompletionOnlyRunId: RunId | undefined;
  switch (command.type) {
    case "thread.create":
      yield* dispatchThreadCreate(command, events);
      break;
    case "thread.visit":
      yield* dispatchThreadVisit(command, events);
      break;
    case "thread.auto-settle": {
      // Recheck live state; changes and explicit overrides take precedence over the sweep snapshot.
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (
        thread.settledOverride !== null ||
        DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} changed before automatic settlement.`,
        });
      }
      yield* dispatchThreadMutation(
        {
          type: "thread.settle",
          commandId: command.commandId,
          threadId: command.threadId,
          ...(command.settledAt === undefined ? {} : { settledAt: command.settledAt }),
        },
        events,
        effects,
      );
      break;
    }
    case "thread.delete": {
      const now = yield* DateTime.now;
      const planDeletion = Effect.fn("Orchestrator.planDeletion")(function* (
        deletion: typeof command,
      ) {
        const projection = yield* projectionStore
          .getThreadRecords(deletion.threadId, [
            "runs",
            "attempts",
            "nodes",
            "runtimeRequests",
            "subagents",
            "providerSessions",
          ])
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: deletion.threadId, cause }),
            ),
          );
        return yield* mapDispatchError(command)(
          planThreadDeletion({
            command: deletion,
            projection,
            attachmentIds: yield* projectionStore
              .getThreadAttachmentIds(deletion.threadId)
              .pipe(mapDispatchError(command)),
            now,
            idAllocator,
          }),
        );
      });
      // Checked under the thread lock: a message sent since the client looked keeps the thread.
      if (command.onlyIfUnused === true) {
        const usage = yield* projectionStore
          .getThreadRecords(command.threadId, ["runs", "messages"])
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        if (usage.runs.length > 0 || usage.messages.length > 0) {
          return { events: [], effects: [] };
        }
      }
      // The dispatch wrapper holds each side chat's lock, so none can commit after this plan.
      const plans = [
        yield* planDeletion(command),
        ...(yield* Effect.forEach(sideChatIds, (threadId) =>
          planDeletion({
            ...command,
            commandId: CommandId.make(`${command.commandId}:side-chat:${threadId}`),
            threadId,
          }),
        )),
      ];
      return {
        events: plans.flatMap((plan) => plan.events),
        effects: plans.flatMap((plan) => plan.effects),
      };
    }
    case "thread.archive":
    case "thread.unarchive":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.tag.set":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider.switch":
      yield* dispatchThreadMutation(command, events, effects);
      break;
    case "thread.pull-request-watch.sync":
      yield* dispatchPullRequestWatchSync(command, events, effects);
      break;
    case "thread.guest-share.open":
    case "thread.guest-share.redeem":
    case "thread.guest-share.close":
    case "thread.guest-message.submit":
    case "thread.guest-message.dismiss":
      yield* dispatchGuestShare(command, events, effects);
      break;
    case "provider-session.detach":
      yield* dispatchProviderSessionDetach(command, events, effects);
      break;
    case "thread.project.adopt-folder":
      yield* dispatchThreadProjectAdoptFolder(command, events);
      break;
    case "message.dispatch": {
      // Providers own native subagent conversations; messages cannot target them, and adapters ask questions on the parent.
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (isProviderNativeSubagentThread(thread)) {
        return yield* new OrchestratorSubagentThreadReadOnlyError({
          commandId: command.commandId,
          threadId: command.threadId,
        });
      }
      const guestSend =
        command.guestMessageId === undefined
          ? undefined
          : yield* emitGuestMessageSent(command, command.guestMessageId, thread, events);
      const dispatched =
        guestSend === undefined
          ? withoutGuestAttribution(command)
          : {
              ...command,
              text: guestSend.text,
              context: { version: 1 as const, records: [], guest: guestSend.guest },
            };
      cancelUnsettledEffects = yield* dispatchMessage(dispatched, events, effects);
      yield* recordSubagentFollowup(dispatched, events).pipe(mapDispatchError(command));
      break;
    }
    case "notification.delivery.accept":
      updateDelegatedCompletionOnlyRunId = yield* dispatchNotificationAccepted(command, events);
      break;
    case "prepared-run.release":
      yield* dispatchPreparedRunRelease(command, events, effects);
      break;
    case "prepared-run.progress":
      yield* dispatchPreparedRunProgress(command, events);
      break;
    case "prepared-run.fail":
      yield* dispatchPreparedRunFail(command, events);
      break;
    case "prepared-run.retry":
      yield* dispatchPreparedRunRetry(command, events);
      break;
    case "runtime-request.respond":
      yield* dispatchRuntimeRequestRespond(command, events, effects);
      break;
    case "thread.user-input.dismiss":
      yield* dispatchThreadUserInputDismiss(command, events, effects);
      break;
    case "subagent.stop":
      yield* dispatchSubagentStop(command, events, effects);
      break;
    case "run.interrupt":
      cancelUnsettledEffects = yield* dispatchRunInterrupt(command, events, effects);
      if (command.holdQueue === true) {
        // Stop must still commit when a child can't be read, so a failed repair's
        // partial events are dropped.
        const repairEvents = yield* Ref.make(yield* Ref.get(events));
        const repaired = yield* Effect.exit(
          loadProjectionForCommand(command, ["subagents", "turnItems"], {
            turnItemTypes: ["subagent"],
            turnItemStatuses: ["pending", "running", "waiting"],
          }).pipe(
            Effect.flatMap((projection) =>
              cancelIdleOrphans({ command, events: repairEvents, projection }),
            ),
          ),
        );
        if (Exit.isSuccess(repaired)) yield* Ref.set(events, yield* Ref.get(repairEvents));
        else
          yield* Effect.logWarning("Stop could not cancel orphaned delegated follow-ups", {
            threadId: command.threadId,
            cause: repaired.cause,
          });
        yield* Ref.update(effects, (existing) => [
          ...existing,
          delegatedTasksStopEffect(command),
        ]);
      }
      break;
    case "thread.stop":
      cancelUnsettledEffects = yield* dispatchThreadStop(command, events, effects);
      break;
    case "queued-message.promote-to-steer":
      cancelUnsettledEffects = yield* dispatchQueuedMessagePromoteToSteer(
        command,
        events,
        effects,
      );
      break;
    case "queued-run.start":
    case "queue.resume": {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "turnItems", "providerSessions", "messages"],
        { turnItemTypes: ["error"], messageRoles: ["user"] },
      );
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} is not active.`,
        });
      }
      const selectedRunId = command.type === "queued-run.start" ? command.runId : undefined;
      const selectedRun =
        selectedRunId === undefined
          ? undefined
          : projection.runs.find((run) => run.id === selectedRunId && run.status === "queued");
      if (selectedRunId !== undefined) {
        const selectedMessage = projection.messages.find(
          (message) => message.id === selectedRun?.userMessageId,
        );
        if (
          selectedRun === undefined ||
          selectedMessage === undefined ||
          selectedMessage.delegatedCompletion !== undefined ||
          selectedMessage.notification !== undefined ||
          projection.runs.some(isActiveRun)
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "A queued user message can only be sent now while the thread is stopped.",
          });
        }
      }
      const nextRun = selectedRun ?? queuedRunsInDeliveryOrder(projection)[0];
      if (
        usageLimitHoldsQueue(
          projection,
          nextRun === undefined
            ? projection.thread.providerInstanceId
            : queuedRunModelSelection(projection, nextRun).instanceId,
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Continue the limited thread before resuming its queue.",
        });
      }
      const now = yield* DateTime.now;
      const queued = projection.runs.filter((run) => run.status === "queued");
      for (const run of queued) {
        yield* emit(
          events,
          command,
        )({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queueHeld: false },
        });
      }
      if (queued.length === 0) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: now,
          payload: projection.thread,
        });
      }
      break;
    }
    case "queued-run.reorder":
      yield* dispatchQueuedRunReorder(command, events);
      break;
    case "queued-run.cancel":
      yield* dispatchQueuedRunCancel(command, events);
      break;
    case "queued-run.edit":
      yield* dispatchQueuedRunEdit(command, events);
      break;
    case "checkpoint.rollback":
      yield* dispatchCheckpointRollback(command, events, effects);
      break;
    case "checkpoint.rollback.fail":
      yield* dispatchCheckpointRollbackFail(command, events);
      break;
    case "runtime-request.delivery.fail":
      yield* dispatchRuntimeRequestDeliveryFail(command, events);
      break;
    case "thread.background-work.settle":
      yield* dispatchBackgroundWorkSettle(command, events, effects);
      break;
    case "thread.interrupt.unresponsive":
      yield* dispatchInterruptUnresponsive(command, events);
      break;
    case "thread.fork":
      yield* dispatchThreadFork(command, events);
      break;
    case "thread.merge_back":
      yield* dispatchThreadMergeBack(command, events);
      break;
    case "delegated_task.request":
      yield* dispatchDelegatedTaskRequest(command, events, effects);
      break;
    case "delegated_task.remote.request":
      yield* dispatchRemoteDelegatedTaskRequest(command, events);
      break;
    case "delegated_task.remote.complete":
      yield* dispatchRemoteDelegatedTaskComplete(command, events);
      break;
    case "delegated_task.remote.stop":
      yield* dispatchRemoteDelegatedTaskStop(command, events);
      break;
    case "delegated_task.wake-policy":
      updateDelegatedCompletionOnlyRunId = yield* dispatchDelegatedTaskWakePolicy(
        command,
        events,
      );
      break;
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      updateDelegatedCompletionOnlyRunId =
        yield* dispatchDelegatedTaskCompletionDeliveryResolution(command, events);
      break;
    case "thread.created.record":
      yield* dispatchCreatedThreadRecord(command, events);
      break;
    case "secret_request.record":
      yield* dispatchSecretRequestRecord(command, events);
      break;
    case "link_request.record":
      yield* dispatchLinkRequestRecord(command, events, effects);
      break;
    default:
      return yield* dispatchUnsupported(command);
  }
  return {
    events: yield* Ref.get(events),
    effects: yield* Ref.get(effects),
    ...(cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects }),
    ...(updateDelegatedCompletionOnlyRunId === undefined
      ? {}
      : { updateDelegatedCompletionOnlyRunId }),
  };
});

  return { dispatchOnce };
});

export type DispatchOncePart = ReturnType<typeof installDispatchOnce> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installDispatchOnce>;
