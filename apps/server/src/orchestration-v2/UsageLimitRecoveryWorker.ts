import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  isProviderDriverKind,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderDriverKind,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

function instanceDriver(
  settings: Pick<ServerSettingsValue, "providerInstances">,
  instanceId: ProviderInstanceId,
): ProviderDriverKind | null {
  if (Object.hasOwn(settings.providerInstances, instanceId))
    return settings.providerInstances[instanceId]!.driver;
  // Unconfigured built-in instances use their driver kind as the instance id.
  return isProviderDriverKind(instanceId) ? instanceId : null;
}

const instanceLabel = (
  settings: Pick<ServerSettingsValue, "providerInstances">,
  instanceId: ProviderInstanceId,
): string =>
  (Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]!.displayName
    : undefined) ?? instanceId;

/**
 * Moves a freshly limited thread to the next enabled instance after its current
 * one in the failover order. Same-driver targets keep the model and options; a
 * different driver starts on that driver's default model.
 */
export function limitFailoverCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  settings: Pick<
    ServerSettingsValue,
    | "usageLimitFailoverEnabled"
    | "usageLimitFailoverOrder"
    | "providerInstances"
    | "projectSettingsOverrides"
  >,
  nowMs: number,
): OrchestrationV2Command | null {
  if (
    !settings.usageLimitFailoverEnabled ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    // An armed recovery means the thread already took the wait-for-reset path.
    thread.limitRecovery?.runId === thread.latestRunId
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= nowMs ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const currentDriver = instanceDriver(settings, thread.providerInstanceId);
  const order = settings.usageLimitFailoverOrder;
  // Only moving forward keeps a chain of limited accounts from cycling.
  for (const instanceId of order.slice(order.indexOf(thread.providerInstanceId) + 1)) {
    if (instanceId === thread.providerInstanceId) continue;
    if (!resolveProjectProviderInstanceEnabled(settings, thread.projectId, instanceId)) continue;
    const driver = instanceDriver(settings, instanceId);
    if (driver === null) continue;
    let modelSelection: ModelSelection;
    if (driver === currentDriver) {
      modelSelection = { ...thread.modelSelection, instanceId };
    } else {
      const model = DEFAULT_MODEL_BY_PROVIDER[driver];
      if (model === undefined) continue;
      modelSelection = { instanceId, model };
    }
    const identity = `${thread.id}:${thread.latestRunId}:${instanceId}`;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-failover:${identity}`),
      messageId: MessageId.make(`limit-failover:${identity}`),
      threadId: thread.id,
      manualContinuationOfRunId: thread.latestRunId,
      modelSelection,
      text: `Usage limit reached on ${instanceLabel(settings, thread.providerInstanceId)}, switched to ${instanceLabel(settings, instanceId)}. Continue where you left off.`,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
  }
  return null;
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      failover: preferences.usageLimitFailoverEnabled,
    });
    let acted = false;
    for (const thread of candidates) {
      const failover = limitFailoverCommand(thread, preferences, nowMs);
      if (failover !== null) {
        const moved = yield* threads.dispatch(failover).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        // A rejected failover falls back to the wait-for-reset path below.
        if (moved) continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
