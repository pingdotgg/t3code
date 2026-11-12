import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic-02-derive.ts";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic-04-timeline.ts";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  contextCompactionTokenCounts,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
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

export type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** A running compaction owns the working row, so its divider appears only once it ends. */
      compacting?: true;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      groupId?: string;
      expanded?: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
      deferredWorkItemIds?: ReadonlyArray<string>;
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      tokenCounts: ReturnType<typeof contextCompactionTokenCounts>;
      active: boolean;
      /** Replaces "Context compacted" when T3 Code compacted without being asked. */
      title?: string;
      failed?: true;
      /** The provider's reason, when a failed compaction gave one. */
      failure?: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      /** Another of your messages follows directly, so the two sit closer together. */
      groupedWithNext?: boolean;
      /** Another of your messages sits directly above, so the joined corners tighten. */
      groupedWithPrevious?: boolean;
      /** Set when the message above is a steer too, so the label shows once. */
      continuesSteer?: boolean;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  /** Every entry in the segment, including the cards a fold never hides. */
  entryIds: ReadonlySet<string>;
  label: string;
}

export interface SupersededAttemptFold {
  readonly deferredWorkItemIds: ReadonlyArray<string>;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

// Interrupted streams can be `completed`; only the attempt's last output proves completion.
export type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

/**
 * Runless (imported V1) turns and work after a steer fold under synthetic
 * keys, so the entry's own run id is not enough to open them.
 */
