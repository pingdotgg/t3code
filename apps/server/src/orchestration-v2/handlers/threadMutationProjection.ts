import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { OrchestrationV2InternalCommand } from "@t3tools/contracts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { recordThreadOpen } from "@t3tools/shared/paletteSearch";
import type { CommandId } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";
import type { CheckpointServiceV2Shape } from "../CheckpointService.ts";
import type { CommandPolicyV2Shape } from "../CommandPolicy.ts";
import type { ContextHandoffServiceV2Shape } from "../ContextHandoffService.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";
import type { ProviderAdapterRegistryV2Shape } from "../ProviderAdapterRegistry.ts";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";
import type { ProviderSwitchServiceV2Shape } from "../ProviderSwitchService.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type { ProjectionRecordField } from "../ProjectionStore.ts";
import type { ProjectionRecordFilter } from "../ProjectionStore.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { mapDispatchError } from "../orchestrationEmitters.ts";
import { OrchestratorCommandRejectedError } from "../orchestrationErrors.ts";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { OrchestratorDomainEventStreamError } from "../orchestrationErrors.ts";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { OrchestratorSubagentThreadReadOnlyError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAlreadyExistsError } from "../orchestrationErrors.ts";
import { RunId } from "@t3tools/contracts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestrationMessages.ts";
import { applyToProjection } from "../ProjectionStore.ts";
import { cancelledBeforeStart } from "../RestartBackgroundNote.ts";
import { canonicalizeGitCafePullRequestUrl } from "@t3tools/source-control-definitions/registry";
import { contextSourcePointForRun } from "../orchestrationCommandQueries.ts";
import { continuationFailedBeforePrompt } from "../RestartBackgroundNote.ts";
import { delegatedCompletionWakeDetail } from "../orchestrationCommandQueries.ts";
import { goalCommandStopsActiveRun } from "../CommandPolicy.ts";
import { isActiveRun } from "../CommandPolicy.ts";
import { isNativeMaintenanceCommand } from "../CommandPolicy.ts";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";
import { isRestartContinuationSource } from "../RestartBackgroundNote.ts";
import { isUndeliveredMailboxSteer } from "../NotificationMailbox.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { latestProviderTurnForAttempt } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { legacyPullRequestLink } from "../orchestrationCommandQueries.ts";
import { legacyThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince } from "../modelSwitch.ts";
import { normalizeThreadPullRequestKey } from "../../sourceControl/threadPullRequests.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import { parseGoalCommand } from "@t3tools/contracts";
import { providerThreadForRun } from "../orchestrationCommandQueries.ts";
import { readForkHistoryItems } from "../ContextHandoffService.ts";
import { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestKeysEqual } from "../../sourceControl/threadPullRequests.ts";
import { threadPullRequestsOf } from "../../sourceControl/threadPullRequests.ts";
import { threadShellFromProjection } from "../ProjectionStore.ts";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { visibleConversationItems } from "../ContextHandoffService.ts";
import { visibleDeltaRunOrdinals } from "../ContextHandoffService.ts";
import { visibleThreadPullRequests } from "../../sourceControl/threadPullRequests.ts";
import { wakeWorkStartedAt } from "../orchestrationCommandQueries.ts";
import { withPullRequestWatch } from "../orchestrationCommandQueries.ts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransfer } from "@t3tools/contracts";
import type { OrchestrationV2ContextTransferResolution } from "@t3tools/contracts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type { OrchestrationV2ExecutionNode } from "@t3tools/contracts";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { isLiveRun } from "../Orchestrator.ts";
import { shouldPrepareLegacyImportHandoff } from "../Orchestrator.ts";
import type { OrchestrationV2RunAttempt } from "@t3tools/contracts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { appendContextHandoffId } from "../Orchestrator.ts";
import { isHandoffSourceRun } from "../Orchestrator.ts";
import { threadPullRequestLinksEqual } from "../Orchestrator.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { MakeMessageHandlersDeps } from "./messageHandlerDeps.ts";
import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

// Extracted from ./messageThreadMutationHandler to keep that module under 800 lines.

export type ThreadMutationCommand = Extract<
    OrchestrationV2ServerCommand,
    {
      readonly type:
        | "thread.archive"
        | "thread.unarchive"
        | "thread.settle"
        | "thread.unsettle"
        | "thread.snooze"
        | "thread.unsnooze"
        | "thread.auto-settle.set"
        | "thread.pin"
        | "thread.unpin"
        | "thread.pin.reorder"
        | "thread.tag.set"
        | "thread.active.reorder"
        | "thread.mark-unread"
        | "thread.metadata.update"
        | "thread.pull-request.link"
        | "thread.pull-request.unlink"
        | "thread.pull-request-link.sync"
        | "thread.pull-request.watch"
        | "thread.pull-request-watch.sync"
        | "thread.pull-request.sync"
        | "thread.title.regeneration.complete"
        | "thread.runtime-mode.set"
        | "thread.interaction-mode.set"
        | "thread.model-selection.set"
        | "provider.switch";
    }
  >;

export interface ApplyThreadMutationParams {
  thread: OrchestrationV2AppThread;
  command: ThreadMutationCommand;
  now: DateTime.Utc;
  snoozedUntil: DateTime.Utc | null;
  markUnreadVisitedAt: DateTime.Utc | null;
}

export const applyThreadMutation = (params: ApplyThreadMutationParams): OrchestrationV2AppThread => {
  const { thread, command, now, snoozedUntil, markUnreadVisitedAt } = params;
  switch (command.type) {
    case "thread.archive":
      return {
        ...thread,
        archivedAt: now,
        titleRegeneration: null,
        guestShare: null,
        pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
        updatedAt: now,
      };
    case "thread.unarchive":
      return { ...thread, archivedAt: null, updatedAt: now };
    case "thread.settle": {
      const wasPinned = thread.pinnedAt != null;
      const alreadySettled =
        thread.settledOverride === "settled" && thread.settledAt !== null && !wasPinned;
      return {
        ...thread,
        settledOverride: "settled",
        settledAt: alreadySettled ? thread.settledAt : (command.settledAt ?? now),
        pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
        unsettledAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt:
          alreadySettled && thread.snoozedUntil == null && thread.snoozedAt == null
            ? thread.updatedAt
            : now,
      };
    }
    case "thread.unsettle": {
      const alreadyPinnedActive = thread.settledOverride === "active";
      return {
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: alreadyPinnedActive ? (thread.unsettledAt ?? null) : now,
        updatedAt: alreadyPinnedActive ? thread.updatedAt : now,
      };
    }
    case "thread.snooze": {
      // Re-snoozing acknowledges the latest wake even at the same time; commandId deduplicates retries.
      return {
        ...thread,
        snoozedUntil,
        limitRecovery: thread.limitRecovery ? { ...thread.limitRecovery, snooze: false } : null,
        snoozedAt: now,
        updatedAt: now,
      };
    }
    case "thread.unsnooze": {
      const alreadyAwake = thread.snoozedUntil == null;
      return {
        ...thread,
        snoozedUntil: null,
        snoozedAt: null,
        lastSnoozeWakeAt: alreadyAwake ? thread.lastSnoozeWakeAt : now,
        updatedAt: alreadyAwake ? thread.updatedAt : now,
      };
    }
    case "thread.auto-settle.set": {
      const unchanged = command.enabled === (thread.autoSettleDisabledAt == null);
      return {
        ...thread,
        autoSettleDisabledAt: command.enabled ? null : (thread.autoSettleDisabledAt ?? now),
        updatedAt: unchanged ? thread.updatedAt : now,
      };
    }
    case "thread.pin": {
      const alreadyPinned = thread.pinnedAt != null;
      const promotes = thread.settledOverride === "settled" || thread.snoozedUntil != null;
      return {
        ...thread,
        pinnedAt: alreadyPinned ? thread.pinnedAt : now,
        ...(alreadyPinned || command.orderKey === undefined
          ? {}
          : { pinOrderKey: command.orderKey }),
        settledOverride:
          thread.settledOverride === "settled" ? "active" : thread.settledOverride,
        settledAt: thread.settledOverride === "settled" ? null : thread.settledAt,
        ...(thread.settledOverride === "settled" ? { unsettledAt: now } : {}),
        snoozedUntil: null,
        snoozedAt: null,
        lastSnoozeWakeAt: thread.snoozedUntil == null ? thread.lastSnoozeWakeAt : now,
        updatedAt: alreadyPinned && !promotes ? thread.updatedAt : now,
      };
    }
    case "thread.unpin": {
      const alreadyUnpinned = thread.pinnedAt == null;
      return {
        ...thread,
        pinnedAt: null,
        pinOrderKey: null,
        updatedAt: alreadyUnpinned ? thread.updatedAt : now,
      };
    }
    case "thread.pin.reorder": {
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      return {
        ...thread,
        pinOrderKey: command.orderKey,
        updatedAt: keyUnchanged ? thread.updatedAt : now,
      };
    }
    case "thread.active.reorder": {
      return {
        ...thread,
        activeOrderKey: command.orderKey,
        updatedAt: thread.updatedAt,
      };
    }
    case "thread.tag.set": {
      const current = thread.tags ?? [];
      return {
        ...thread,
        tags: command.tagged
          ? current.includes(command.tag)
            ? current
            : [...current, command.tag]
          : current.filter((tag) => tag !== command.tag),
      };
    }
    case "thread.mark-unread": {
      // Retire the wake before rewinding the visit, preserving its settlement timer.
      const snoozeExpired =
        thread.snoozedUntil != null &&
        DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now);
      return {
        ...thread,
        lastVisitedAt: markUnreadVisitedAt,
        ...(snoozeExpired
          ? { snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: thread.snoozedUntil }
          : {}),
      };
    }
    case "thread.metadata.update": {
      const previousRecovery =
        thread.limitRecovery?.runId === command.limitRecovery?.runId &&
        thread.limitRecovery?.resetAt === command.limitRecovery?.resetAt
          ? thread.limitRecovery
          : null;
      const limitRecovery =
        command.limitRecovery === undefined
          ? thread.limitRecovery
          : command.limitRecovery === null
            ? null
            : {
                ...command.limitRecovery,
                autoResume:
                  command.limitRecovery.autoResume ?? previousRecovery?.autoResume ?? false,
                snooze: command.limitRecovery.snooze ?? previousRecovery?.snooze ?? false,
                requestId: command.commandId,
              };
      return {
        ...thread,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.limitRecovery === undefined ? {} : { limitRecovery }),
        ...(command.limitRecovery !== undefined &&
        limitRecovery?.snooze === true &&
        Date.parse(limitRecovery.resetAt) > DateTime.toEpochMillis(now)
          ? {
              snoozedUntil: DateTime.makeUnsafe(limitRecovery.resetAt),
              // Recovery updates acknowledge the same stopped run; their timestamps must not trigger fresh failure wakes.
              snoozedAt: now,
            }
          : command.limitRecovery !== undefined &&
              thread.limitRecovery?.snooze &&
              thread.snoozedUntil != null &&
              DateTime.toEpochMillis(thread.snoozedUntil) ===
                Date.parse(thread.limitRecovery.resetAt)
            ? { snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: now }
            : {}),
        ...(command.branch === undefined ? {} : { branch: command.branch }),
        ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
        ...(command.linkedPullRequest === undefined
          ? {}
          : {
              linkedPullRequest: command.linkedPullRequest,
              pullRequests: [
                ...threadPullRequestsOf(thread).filter(
                  (link) =>
                    !(
                      thread.linkedPullRequest &&
                      threadPullRequestKeysEqual(
                        link,
                        legacyThreadPullRequestKey(thread.linkedPullRequest),
                      )
                    ) &&
                    !(
                      command.linkedPullRequest &&
                      threadPullRequestKeysEqual(
                        link,
                        legacyThreadPullRequestKey(command.linkedPullRequest),
                      )
                    ),
                ),
                ...(command.linkedPullRequest
                  ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                  : []),
              ],
            }),
        ...(command.regenerateTitle === true
          ? { titleRegeneration: { requestId: command.commandId, startedAt: now } }
          : command.regenerateTitle === false || command.title !== undefined
            ? { titleRegeneration: null }
            : {}),
        updatedAt: now,
      };
    }
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync": {
      const key = normalizeThreadPullRequestKey(command);
      const links = threadPullRequestsOf(thread);
      const existing = links.find((link) => threadPullRequestKeysEqual(link, key));
      let pullRequests = links;
      if (command.type === "thread.pull-request.link") {
        const undismisses =
          existing?.source === "stack-dismissed" &&
          command.source !== "stack" &&
          command.source !== "stack-dismissed";
        if (existing && !undismisses) return thread;
        const link = existing
          ? {
              ...existing,
              source: command.source,
              url: canonicalizeGitCafePullRequestUrl(command.url),
              ...(command.repositoryWebUrl !== undefined && {
                repositoryWebUrl: command.repositoryWebUrl,
              }),
            }
          : {
              ...key,
              url: canonicalizeGitCafePullRequestUrl(command.url),
              ...(command.repositoryWebUrl !== undefined && {
                repositoryWebUrl: command.repositoryWebUrl,
              }),
              source: command.source,
              linkedAt: DateTime.formatIso(now),
              snapshot: null,
              stack: null,
            };
        const branch = thread.branchPullRequest;
        const branchKey = branch ? legacyThreadPullRequestKey(branch) : null;
        pullRequests = [
          ...(command.source === "manual" &&
          branch &&
          branchKey &&
          visibleThreadPullRequests(links).length === 0 &&
          !threadPullRequestKeysEqual(branchKey, key) &&
          !links.some((entry) => threadPullRequestKeysEqual(entry, branchKey))
            ? [
                {
                  ...branchKey,
                  url: canonicalizeGitCafePullRequestUrl(branch.url),
                  source: "manual" as const,
                  linkedAt: DateTime.formatIso(now),
                  snapshot: null,
                  stack: null,
                },
              ]
            : []),
          ...links.filter((entry) => !threadPullRequestKeysEqual(entry, key)),
          link,
        ];
      } else if (command.type === "thread.pull-request.unlink") {
        if (!existing) return thread;
        const belongsToStack =
          existing.source === "stack" ||
          existing.stack !== null ||
          links.some(
            (link) =>
              link.host.toLowerCase() === key.host &&
              link.repository.toLowerCase() === key.repository &&
              link.stack?.layers.some((layer) => layer.number === key.number),
          );
        pullRequests = belongsToStack
          ? links.map((link) =>
              link === existing
                ? {
                    ...withPullRequestWatch(link, undefined),
                    source: "stack-dismissed" as const,
                  }
                : link,
            )
          : links.filter((link) => link !== existing);
      } else {
        if (!existing) return thread;
        pullRequests = links.map((link) =>
          link === existing
            ? { ...link, snapshot: command.snapshot, stack: command.stack }
            : link,
        );
      }
      return {
        ...thread,
        pullRequests,
        linkedPullRequest:
          thread.linkedPullRequest &&
          pullRequests.some(
            (link) =>
              link.source !== "stack-dismissed" &&
              threadPullRequestKeysEqual(
                link,
                legacyThreadPullRequestKey(thread.linkedPullRequest!),
              ),
          )
            ? thread.linkedPullRequest
            : null,
        updatedAt: command.type === "thread.pull-request-link.sync" ? thread.updatedAt : now,
      };
    }
    case "thread.pull-request.watch":
    case "thread.pull-request-watch.sync": {
      const key = normalizeThreadPullRequestKey(command);
      const startedAt = DateTime.formatIso(now);
      const linked = threadPullRequestsOf(thread);
      const visible = (link: ThreadPullRequestLink) =>
        link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key);
      const dismissed = linked.find((link) => threadPullRequestKeysEqual(link, key));
      const links =
        command.type === "thread.pull-request.watch" &&
        command.watching &&
        command.link !== undefined &&
        !linked.some(visible)
          ? [
              ...linked.filter((link) => !threadPullRequestKeysEqual(link, key)),
              {
                ...key,
                url: canonicalizeGitCafePullRequestUrl(command.link.url),
                ...((command.link.repositoryWebUrl ?? dismissed?.repositoryWebUrl) !==
                  undefined && {
                  repositoryWebUrl:
                    command.link.repositoryWebUrl ?? dismissed?.repositoryWebUrl,
                }),
                source: command.link.source,
                linkedAt: startedAt,
                snapshot: null,
                stack: null,
                ...(dismissed?.endedWatch && { endedWatch: dismissed.endedWatch }),
              },
            ]
          : linked;
      const existing = links.find(visible);
      if (existing === undefined) return thread;
      const watch =
        command.type === "thread.pull-request-watch.sync"
          ? existing.watch?.startedAt === command.startedAt
            ? (command.watch ?? undefined)
            : existing.watch
          : !command.watching
            ? undefined
            : (existing.watch ?? {
                startedAt,
                headSha: null,
                failedChecks: [],
                passed: false,
                passedChecks: [],
                conflicting: false,
                // Watching again must not repeat check or conflict news the last watch told.
                ...(existing.endedWatch && {
                  headSha: existing.endedWatch.headSha,
                  failedChecks: existing.endedWatch.failedChecks,
                  passed: existing.endedWatch.passed,
                  passedChecks: existing.endedWatch.passedChecks,
                  conflicting: existing.endedWatch.conflicting,
                }),
                ...(existing.endedWatch?.owedChecks !== undefined && {
                  owedChecks: existing.endedWatch.owedChecks,
                }),
                ...(existing.endedWatch?.checksAwaitedSince !== undefined && {
                  checksAwaitedSince: existing.endedWatch.checksAwaitedSince,
                }),
                remarksThrough: startedAt,
                remarkIds: [],
                wakes: 0,
              });
      if (watch === existing.watch && links === linked) return thread;
      const final =
        command.type === "thread.pull-request-watch.sync" && watch === undefined
          ? command.endedWatch
          : undefined;
      return {
        ...thread,
        pullRequests: links.map((link) =>
          link === existing
            ? withPullRequestWatch(final ? { ...link, watch: final } : link, watch)
            : link,
        ),
        updatedAt: command.type === "thread.pull-request.watch" ? now : thread.updatedAt,
      };
    }
    case "thread.pull-request.sync":
      return {
        ...thread,
        branchPullRequest: command.branchPullRequest,
        ...(command.linkedPullRequest === undefined
          ? {}
          : {
              linkedPullRequest: command.linkedPullRequest,
              pullRequests: [
                ...threadPullRequestsOf(thread).filter(
                  (link) =>
                    !(
                      thread.linkedPullRequest &&
                      threadPullRequestKeysEqual(
                        link,
                        legacyThreadPullRequestKey(thread.linkedPullRequest),
                      )
                    ) &&
                    !(
                      command.linkedPullRequest &&
                      threadPullRequestKeysEqual(
                        link,
                        legacyThreadPullRequestKey(command.linkedPullRequest),
                      )
                    ),
                ),
                ...(command.linkedPullRequest
                  ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                  : []),
              ],
            }),
        updatedAt: thread.updatedAt,
      };
    case "thread.title.regeneration.complete":
      return thread.titleRegeneration?.requestId === command.requestId
        ? {
            ...thread,
            ...(command.title === undefined ? {} : { title: command.title }),
            titleRegeneration: null,
            updatedAt: now,
          }
        : thread;
    case "thread.runtime-mode.set":
      return { ...thread, runtimeMode: command.runtimeMode, updatedAt: now };
    case "thread.interaction-mode.set":
      return { ...thread, interactionMode: command.interactionMode, updatedAt: now };
    case "thread.model-selection.set":
    case "provider.switch":
      return {
        ...thread,
        providerInstanceId: command.modelSelection.instanceId,
        modelSelection: command.modelSelection,
        updatedAt: now,
      };
  }
};
