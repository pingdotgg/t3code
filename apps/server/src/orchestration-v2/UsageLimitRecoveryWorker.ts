import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
  type ServerSettings as ServerSettingsContract,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { routineSpan } from "@t3tools/shared/observability";
import {
  isFallbackOriginRestorable,
  isModelSelectionUsable,
  type UsageLimitCooldownEntry,
} from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitCooldownStore from "./UsageLimitCooldownStore.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;
const MAX_FALLBACK_SWITCH_AGE_MS = 10 * 60 * 1000;

const FALLBACK_CONTINUATION_PROMPT =
  "Continue where you left off. The previous agent hit a usage limit, so this thread was automatically switched to your fallback model. Check the workspace state before repeating any side-effecting action.";

export function fallbackSwitchCommand(input: {
  readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  readonly settings: ServerSettingsContract;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cooldowns: ReadonlyArray<UsageLimitCooldownEntry>;
  readonly nowMs: number;
}): OrchestrationV2Command | null {
  const { thread, settings, providers, cooldowns, nowMs } = input;
  const fallback = settings.fallbackModelSelection;
  if (
    !settings.fallbackOnUsageLimit ||
    fallback === null ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.modelSelection ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  ) {
    return null;
  }
  // Respect a manual model change made after the run failed.
  if (
    thread.currentModelSelection !== undefined &&
    !modelSelectionsEqual(thread.currentModelSelection, thread.modelSelection)
  ) {
    return null;
  }
  // Never loop back onto the same provider instance + model that just hit a limit.
  if (
    thread.modelSelection.instanceId === fallback.instanceId &&
    thread.modelSelection.model === fallback.model
  ) {
    return null;
  }
  const failedAtMs = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  if (nowMs - failedAtMs > MAX_FALLBACK_SWITCH_AGE_MS) {
    return null;
  }
  // If the reported reset time has already passed, stay on the original model.
  if (thread.usageLimitResetAt != null) {
    const resetMs = Date.parse(thread.usageLimitResetAt);
    if (Number.isFinite(resetMs) && resetMs <= nowMs) {
      return null;
    }
  }
  if (
    !isModelSelectionUsable({
      selection: fallback,
      providers,
      now: nowMs,
      settings,
      projectId: thread.projectId ?? null,
      cooldowns,
    })
  ) {
    return null;
  }
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-fallback:${identity}`),
    messageId: MessageId.make(`limit-fallback:${identity}`),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: fallback,
    fallbackOrigin: {
      originSelection: thread.modelSelection,
      fallbackSelection: fallback,
      switchedFromRunId: thread.latestRunId,
      switchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      resetAt: thread.usageLimitResetAt ?? null,
    },
    text: FALLBACK_CONTINUATION_PROMPT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

export function fallbackRestoreCommand(input: {
  readonly thread: ProjectionStore.ProjectionFallbackRestoreCandidate;
  readonly settings: ServerSettingsContract;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cooldowns: ReadonlyArray<UsageLimitCooldownEntry>;
  readonly nowMs: number;
}): OrchestrationV2Command | null {
  const { thread, settings, providers, cooldowns, nowMs } = input;
  // Respect any manual model change made after the automatic fallback switch.
  if (!modelSelectionsEqual(thread.modelSelection, thread.fallbackOrigin.fallbackSelection)) {
    return null;
  }
  if (
    !isFallbackOriginRestorable({
      fallbackOrigin: thread.fallbackOrigin,
      providers,
      now: nowMs,
      settings,
      projectId: thread.projectId,
      cooldowns,
    })
  ) {
    return null;
  }
  const switchedAtMs = Date.parse(thread.fallbackOrigin.switchedAt);
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(
      `limit-restore:${thread.id}:${Number.isFinite(switchedAtMs) ? switchedAtMs : nowMs}`,
    ),
    threadId: thread.id,
    modelSelection: thread.fallbackOrigin.originSelection,
    fallbackOrigin: null,
    expectedFallbackSelection: thread.fallbackOrigin.fallbackSelection,
  };
}

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
  const providerRegistry = Option.getOrUndefined(
    yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry),
  );
  const cooldownStore = Option.getOrUndefined(
    yield* Effect.serviceOption(UsageLimitCooldownStore.UsageLimitCooldownStore),
  );
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  if (providerRegistry !== undefined) {
    yield* forkParked(Stream.runForEach(providerRegistry.streamChanges, () => due.invalidate));
  }
  return Effect.fn("UsageLimitRecoveryWorker.sweep", { attributes: routineSpan })(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const fallbackEnabled =
      preferences.fallbackOnUsageLimit === true && preferences.fallbackModelSelection !== null;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      ...(fallbackEnabled ? { fallbackOnUsageLimit: true } : {}),
    });
    const providers = providerRegistry === undefined ? null : yield* providerRegistry.getProviders;
    const restoreCandidates =
      providers === null
        ? []
        : yield* projections.getFallbackRestoreCandidates.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.limit-recovery.restore-query-failed", {
                cause,
              }).pipe(
                Effect.as([] as ReadonlyArray<ProjectionStore.ProjectionFallbackRestoreCandidate>),
              ),
            ),
          );
    // Record all candidate cooldowns before reading active cooldowns for switch/restore decisions.
    if (cooldownStore !== undefined) {
      for (const thread of candidates) {
        if (
          thread.modelSelection !== undefined &&
          thread.usageLimitResetAt != null &&
          Date.parse(thread.usageLimitResetAt) > nowMs
        ) {
          yield* cooldownStore.record({
            instanceId: thread.modelSelection.instanceId,
            model: thread.modelSelection.model,
            failedAtMs: DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
            resetAt: thread.usageLimitResetAt ?? null,
          });
        }
      }
      for (const thread of restoreCandidates) {
        if (
          thread.fallbackOrigin.resetAt !== null &&
          Date.parse(thread.fallbackOrigin.resetAt) > nowMs
        ) {
          yield* cooldownStore.record({
            instanceId: thread.fallbackOrigin.originSelection.instanceId,
            model: thread.fallbackOrigin.originSelection.model,
            failedAtMs: Date.parse(thread.fallbackOrigin.switchedAt) || nowMs,
            resetAt: thread.fallbackOrigin.resetAt,
          });
        }
      }
    }
    const activeCooldowns =
      cooldownStore === undefined ? [] : yield* cooldownStore.getActive(nowMs);
    let acted = false;
    for (const thread of candidates) {
      const command =
        (providers !== null
          ? fallbackSwitchCommand({
              thread,
              settings: preferences,
              providers,
              cooldowns: activeCooldowns,
              nowMs,
            })
          : null) ??
        limitRecoveryCommand(
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
    if (providers !== null) {
      for (const thread of restoreCandidates) {
        const command = fallbackRestoreCommand({
          thread,
          settings: preferences,
          providers,
          cooldowns: activeCooldowns,
          nowMs,
        });
        if (command === null) continue;
        acted = true;
        yield* threads.dispatch(command).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.restore-dispatch-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
      }
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
