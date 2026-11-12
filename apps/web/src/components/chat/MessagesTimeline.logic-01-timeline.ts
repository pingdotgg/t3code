import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic-02-derive.ts";
import { deriveTimelineTurnFolds } from "./MessagesTimeline.logic-03-derive.ts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic-04-timeline.ts";
import type { MessagesTimelineRowsInput, MessagesTimelineRowsProjection, StableMessagesTimelineRowsState } from "./MessagesTimeline.logic-05-messages.ts";
import * as Equal from "effect/Equal";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { shallow } from "zustand/vanilla/shallow";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
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
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@t3tools/shared/mcpApp";

export function timelineTurnFoldRunIdsByEntryId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
): ReadonlyMap<string, RunId> {
  const byEntryId = new Map<string, RunId>();
  for (const fold of deriveTimelineTurnFolds(input).values()) {
    for (const entryId of fold.hiddenEntryIds) byEntryId.set(entryId, fold.runId);
  }
  return byEntryId;
}

export function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

export function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    pendingApprovalRequestIds: previousPendingApprovalRequestIds,
    availableRevertTurnCounts: previousAvailableRevertTurnCounts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    pendingApprovalRequestIds,
    availableRevertTurnCounts,
    ...context
  } = input;
  // Shell/checkpoint selectors rebuild summaries per event; compare contents.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousPendingApprovalRequestIds, pendingApprovalRequestIds) ||
    !shallow(previousAvailableRevertTurnCounts, availableRevertTurnCounts) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index]!;
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

export function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt && a.compacting === (b as typeof a).compacting
      );
    case "thinking": {
      const bt = b as typeof a;
      return a.createdAt === bt.createdAt && a.groupId === bt.groupId && a.expanded === bt.expanded;
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "attempt-fold":
    case "turn-fold": {
      const bf = b as typeof a;
      const anchors = a.deferredWorkItemIds ?? [];
      const nextAnchors = bf.deferredWorkItemIds ?? [];
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        anchors.length === nextAnchors.length &&
        anchors.every((id, index) => id === nextAnchors[index])
      );
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return (
        a.createdAt === bc.createdAt &&
        a.label === bc.label &&
        a.active === bc.active &&
        a.title === bc.title &&
        a.failed === bc.failed &&
        a.failure === bc.failure
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Tool updates rebuild entries; preserve frames for unchanged pages.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "mcp-app": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.groupedWithNext === bm.groupedWithNext &&
        a.groupedWithPrevious === bm.groupedWithPrevious &&
        a.continuesSteer === bm.continuesSteer
      );
    }
  }
}

export const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
export const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
export const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

export function visibleUserMessageText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

export function handoffRunsSignature(runs: ReadonlyArray<HandoffTimelineRun>): string {
  return runs
    .map(
      (run) =>
        `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
    )
    .join("\n");
}

// Expanded-id sets can be rebuilt during render; comparing them by content keeps
// the render-time state update in useIncrementalTimelineRows from repeating forever.
export function sameRowsInput(
  left: MessagesTimelineRowsInput,
  right: MessagesTimelineRowsInput,
): boolean {
  for (const key of Object.keys(right) as Array<keyof MessagesTimelineRowsInput>) {
    const previous = left[key];
    const next = right[key];
    if (Object.is(previous, next)) continue;
    if (previous instanceof Set && next instanceof Set && shallow(previous, next)) continue;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}

