import { WORKTREE_SETUP_ROW_ID, attachCreatedThreadSummaries, attachTrailingToolGroupsToAssistant, deriveActiveVisualResponseRunIds, deriveTurnFolds, deriveUnsettledRunId, failedTimelineRunIds, itemizedFailedRunIds, lastResponseBoundaryIndex, liveSubagentCardEntryIds, messageIsSteer, timelineEntryIsCompaction, timelineRowEntries, timelineRowIsOwnUserMessage, timelineRowIsWorkLog } from "./MessagesTimeline.logic-03-derive.ts";
import { LIVE_ACTIVITY_ROW_ID, completeSupersededReplyEntryIds, deriveSupersededAttemptFolds, deriveTerminalAssistantMessageIds, expandedWorkGroupRow, singleToolCallLabel, timelineEntryRunId, workEntryIsActiveTurnActivity, workEntryIsVisibleInGroup, workGroupId } from "./MessagesTimeline.logic-04-timeline.ts";
import type { MessagesTimelineRow, TimelineLatestRun } from "./MessagesTimeline.logic-04-timeline.ts";
import { groupOwnUserMessages } from "./messagesTimeline.logic-05-grouping.ts";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { claudeResumeCompactionAge } from "@t3tools/shared/claudeCompaction";
import { IDLE_COMPACTING_LABELS, IDLE_COMPACTION_TITLES } from "@t3tools/client-runtime/user-message";
import { liveActivityToolStatus, normalizeCompactToolLabel, resolveWorkEntryToolPresentation, summarizeToolGroup, toolGroupAction, toolGroupSummaryKind, contextCompactionTokenCounts, type ToolGroupSummaryKind } from "@t3tools/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  formatDuration,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  idleCompactionOf,
  isCompactionCommandMessage,
  type MessageId,
  type OrchestrationV2IdleCompaction,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type RunAttemptId,
  type RuntimeRequestId,
  RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  pendingApprovalRequestIds?: ReadonlySet<RuntimeRequestId>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /** Native subagent work has no app run; runless entries form the live response. */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  worktreeSetup?: WorktreeSetupSnapshot | null;
}): MessagesTimelineRow[] {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const isPendingApproval = (entry: WorkLogEntry) => {
    const item = entry.projectedItem?.item;
    return (
      item?.type === "approval_request" &&
      input.pendingApprovalRequestIds?.has(item.requestId) === true
    );
  };
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
        threadStartCheckpointReady: input.threadStartCheckpointReady === true,
        unsettledRunId,
        availableRevertTurnCounts: input.availableRevertTurnCounts,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const itemizedRunIds = itemizedFailedRunIds(timelineEntries, failedRunIds);
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries);
  const completeSupersededReplyIds = completeSupersededReplyEntryIds(timelineEntries);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
    liveSubagentEntryIds,
    completeSupersededReplyIds,
  );
  const supersededWorkItemIds = new Set(
    [...supersededFoldsByAnchorEntryId.values()].flatMap((fold) => fold.deferredWorkItemIds),
  );
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
    runlessWorkActive,
    liveSubagentEntryIds,
    completeSupersededReplyEntryIds: completeSupersededReplyIds,
  });
  const timelineEntryById = new Map(timelineEntries.map((entry) => [entry.id, entry]));
  const collapsedEntryIds = new Set<string>();
  const collapsedFoldMemberIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedRunIds?.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
      for (const entryId of fold.entryIds) {
        collapsedFoldMemberIds.add(entryId);
      }
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!input.expandedAttemptIds?.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  if (input.pendingApprovalRequestIds?.size) {
    for (const entry of timelineEntries) {
      if (entry.kind === "work" && isPendingApproval(entry.entry)) {
        collapsedEntryIds.delete(entry.id);
        collapsedSupersededEntryIds.delete(entry.id);
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        entry.entry.questionAnswer !== undefined ||
        isPendingApproval(entry.entry) ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      activeToolEntries.push(entry);
    }
  }
  activeToolEntries.reverse();
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) &&
      !input.pendingApprovalRequestIds?.size);
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  // A bare `/compact` turn is the compaction itself: one compaction row stands in for its prompt
  // and working indicator, from the moment the turn starts. Likewise an answered "compact before
  // continuing?" question folds into the compaction it asked for.
  const compactionRuns = new Map<RunId, OrchestrationV2IdleCompaction | undefined>();
  const compactedRunIds = new Set<RunId>();
  const pendingResumeCompactionAgeByRunId = new Map<RunId, string>();
  const resumeCompactionAgeByEntryId = new Map<string, string>();
  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.runId !== null &&
      isCompactionCommandMessage(entry.message)
    ) {
      compactionRuns.set(entry.message.runId, idleCompactionOf(entry.message));
    } else if (entry.kind === "work" && entry.entry.runId) {
      if (timelineEntryIsCompaction(entry)) {
        compactedRunIds.add(entry.entry.runId);
        const age = pendingResumeCompactionAgeByRunId.get(entry.entry.runId);
        if (age !== undefined) {
          resumeCompactionAgeByEntryId.set(entry.id, age);
          pendingResumeCompactionAgeByRunId.delete(entry.entry.runId);
        }
      }
      const age = entry.entry.questionAnswer
        ? claudeResumeCompactionAge(entry.entry.questionAnswer)
        : null;
      if (age !== null) pendingResumeCompactionAgeByRunId.set(entry.entry.runId, age);
    }
  }
  const compactionTitle = (runId: RunId | null | undefined, entryId: string) => {
    if (runId == null) return undefined;
    const reason = compactionRuns.get(runId);
    if (reason !== undefined) return IDLE_COMPACTION_TITLES[reason];
    const age = resumeCompactionAgeByEntryId.get(entryId);
    return age ? `Context compacted after ${age} idle` : undefined;
  };
  const activeCompactionEntry = timelineEntries.find(
    (entry): entry is Extract<TimelineEntry, { kind: "work" }> =>
      timelineEntryIsCompaction(entry) &&
      entry.kind === "work" &&
      workEntryIsInActiveRun(entry.entry),
  );
  const activeRunIsCompaction =
    input.isWorking && unsettledRunId !== null && compactionRuns.has(unsettledRunId);
  // The item can finish before its run settles; only other work should keep activity visible.
  const compactionRunFinished =
    activeRunIsCompaction &&
    compactedRunIds.has(unsettledRunId) &&
    activeCompactionEntry === undefined;
  const compactionOnlyRunFinished =
    compactionRunFinished &&
    !timelineEntries.some(
      (entry) =>
        timelineEntryRunId(entry) === unsettledRunId &&
        !timelineEntryIsCompaction(entry) &&
        !(entry.kind === "message" && isCompactionCommandMessage(entry.message)),
    );
  const runningCompactionRunId =
    activeRunIsCompaction && !compactionRunFinished ? unsettledRunId : null;
  // Compacting on return holds back the message the user just sent, so the working row says why
  // it is waiting. Any other compaction shows only its live divider, never both.
  const compactsOnReturn =
    runningCompactionRunId !== null && compactionRuns.get(runningCompactionRunId) === "onReturn";
  // The question is answered mid-turn, so the row times this compaction, not the turn.
  const resumeCompactionEntry =
    activeCompactionEntry?.entry.runId != null &&
    resumeCompactionAgeByEntryId.has(activeCompactionEntry.id)
      ? activeCompactionEntry
      : undefined;
  const activeCompactionRunId = compactsOnReturn
    ? runningCompactionRunId
    : (resumeCompactionEntry?.entry.runId ?? null);
  const appendWorkingRow = () => {
    if (compactionOnlyRunFinished) return;
    if (runningCompactionRunId !== null && activeCompactionRunId === null) return;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt:
        (compactsOnReturn ? undefined : resumeCompactionEntry?.entry.createdAt) ??
        input.activeTurnStartedAt ??
        null,
      ...(activeCompactionRunId !== null ? { compacting: true as const } : {}),
    });
  };
  let hasActivityRow = false;
  const hasActiveCompaction =
    activeCompactionEntry !== undefined || (activeRunIsCompaction && !compactionRunFinished);
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    // A stopped compaction's own divider already says it stopped.
    if (
      timelineEntry.kind === "event" &&
      (timelineEntry.projectedItem.item.type === "run_interrupt_request" ||
        (timelineEntry.projectedItem.item.type === "run_interrupt_result" &&
          timelineEntry.projectedItem.item.runId !== null &&
          compactionRuns.has(timelineEntry.projectedItem.item.runId) &&
          compactedRunIds.has(timelineEntry.projectedItem.item.runId)))
    ) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      const deferredWorkItemIds = [...turnFold.entryIds].flatMap((entryId) => {
        const entry = timelineEntryById.get(entryId);
        return entry?.kind === "work" &&
          entry.entry.projectedItem?.item.deferredWork &&
          !supersededWorkItemIds.has(String(entry.entry.projectedItem.sourceItemId))
          ? [String(entry.entry.projectedItem.sourceItemId)]
          : [];
      });
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        ...(deferredWorkItemIds.length > 0 ? { deferredWorkItemIds } : {}),
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        deferredWorkItemIds: supersededFold.deferredWorkItemIds,
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      if (
        active &&
        activeCompactionRunId !== null &&
        timelineEntry.entry.runId === activeCompactionRunId
      )
        continue;
      const compaction = timelineEntry.entry.structuredPayload;
      const compactionRunId = timelineEntry.entry.runId;
      const title = compactionTitle(compactionRunId, timelineEntry.id);
      const reason = compactionRunId == null ? undefined : compactionRuns.get(compactionRunId);
      const failed = compaction?.type === "compaction" && compaction.status === "failed";
      const failure = failed ? compaction.summary?.trim() || undefined : undefined;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        ...(title ? { title } : {}),
        ...(failed ? { failed: true } : {}),
        ...(failure ? { failure } : {}),
        createdAt: timelineEntry.createdAt,
        label: active && reason ? IDLE_COMPACTING_LABELS[reason] : timelineEntry.entry.label,
        tokenCounts:
          compaction?.type === "compaction" ? contextCompactionTokenCounts(compaction) : null,
        active,
      });
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.runId != null &&
      compactedRunIds.has(timelineEntry.entry.runId) &&
      timelineEntry.entry.questionAnswer !== undefined &&
      claudeResumeCompactionAge(timelineEntry.entry.questionAnswer) !== null
    ) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        isPendingApproval(timelineEntry.entry) ||
        (timelineEntry.entry.runId != null && itemizedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification" ||
        timelineEntry.entry.questionAnswer !== undefined
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          (nextEntry.entry.itemType === "error" &&
            nextEntry.entry.toolLifecycleStatus === "failed") ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          nextEntry.entry.questionAnswer !== undefined ||
          isPendingApproval(nextEntry.entry) ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary:
              singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const previous = nextRows.at(-1);
      if (
        timelineEntry.projectedItem.item.type === "subagent" &&
        previous?.kind === "event" &&
        previous.projectedItem.item.type === "subagent" &&
        previous.projectedItem.item.runId === timelineEntry.projectedItem.item.runId &&
        previous.projectedItem.item.providerTurnId ===
          timelineEntry.projectedItem.item.providerTurnId
      ) {
        nextRows[nextRows.length - 1] = {
          ...previous,
          subagents: [
            ...(previous.subagents ?? [previous.projectedItem]),
            timelineEntry.projectedItem,
          ],
        };
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const compactionRunId = timelineEntry.message.runId;
    const compactionRun =
      compactionRunId !== null && isCompactionCommandMessage(timelineEntry.message);
    if (compactionRun) {
      if (!compactedRunIds.has(compactionRunId) && compactionRunId !== activeCompactionRunId) {
        const pending = compactionRunId === runningCompactionRunId;
        const reason = compactionRuns.get(compactionRunId);
        nextRows.push({
          kind: "context-compaction",
          id: `compaction:${compactionRunId}`,
          createdAt: timelineEntry.createdAt,
          label: pending
            ? reason
              ? IDLE_COMPACTING_LABELS[reason]
              : "Compacting context"
            : "Context compaction",
          tokenCounts: null,
          active: pending,
        });
      }
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    input.latestRun?.turnEnded !== true &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    !compactionOnlyRunFinished &&
    (latestToolFailed || (!hasActivityRow && !input.pendingApprovalRequestIds?.size))
  ) {
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
      });
    }
  }

  const result = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries, collapsedFoldMemberIds),
  );
  return groupOwnUserMessages(result);
}
