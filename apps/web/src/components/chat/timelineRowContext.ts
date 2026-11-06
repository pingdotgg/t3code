import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { createContext, type MouseEvent, type ReactNode } from "react";
import { type LegendListRef } from "@legendapp/list/react";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import type { PendingApproval } from "../../session-logic";
import { type ChatFileAttachment } from "../../types";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import { type AssistantCitationTarget } from "./AssistantCitationSource";
import { type MessagesTimelineRow, type WorkGroupScrollAnchor } from "./MessagesTimeline.logic";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import type { TurnItemDetailSource } from "../../state/queries";
import { type HandoffTimelineRun } from "./V2LifecycleRow";

/** Edit the last user message in place (MT Code fork; see ./userMessageEdit.ts). */
export interface TimelineMessageEditState {
  /** The one user message that may be edited now. Its row also needs a rollback point. */
  readonly editableMessageId: MessageId | null;
  readonly editingMessageId: MessageId | null;
  readonly isSaving: boolean;
  /** The draft survives the virtualized row unmounting and remounting. */
  readonly readDraft: () => string | null;
  readonly onDraftChange: (draft: string) => void;
  readonly onBegin: (messageId: MessageId) => void;
  readonly onCancel: () => void;
  readonly onSave: (input: {
    readonly messageId: MessageId;
    readonly turnCount: number;
    readonly draft: string;
  }) => void;
}

export const NO_MESSAGE_EDIT: TimelineMessageEditState = {
  editableMessageId: null,
  editingMessageId: null,
  isSaving: false,
  readDraft: () => null,
  onDraftChange: () => {},
  onBegin: () => {},
  onCancel: () => {},
  onSave: () => {},
};

/**
 * Where an expanded row reads an item's detail and a command's output. The owner's rows read them
 * from the environment; the guest page reads them through its own routes.
 */
export interface TurnItemSource {
  readonly detail: TurnItemDetailSource;
  readonly commandOutput: (target: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Atom.Atom<AsyncResult.AsyncResult<CommandOutputView, unknown>>;
}

export interface TimelineRowSharedState {
  searchMessageId: MessageId | null;
  pendingApprovals: ReadonlyMap<RuntimeRequestId, PendingApproval>;
  respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  canOperateThread: boolean;
  onRespondToApproval:
    | ((requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => Promise<unknown>)
    | undefined;
  citationRequest: AssistantCitationTarget | null;
  listRef: React.RefObject<LegendListRef | null>;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  messageEdit: TimelineMessageEditState;
  onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  onSendAppMessage: ((text: string) => Promise<void>) | undefined;
  onAppFullscreenChange: (rowId: string, fullscreen: boolean) => void;
  onRunShellCommand: ((command: string) => void) | undefined;
  findActive: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  displayThreadKey?: string;
  onOpenToolDiff: ((target: ToolCallDiffTarget) => void) | undefined;
  /** Unset where there is no diff to open, so the timeline shows no "Open diff" button. */
  onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
  /**
   * Draws a published HTML visual. Unset, the row loads it from the environment; the guest page
   * loads it through its own route.
   */
  renderHtmlRender: ((row: Extract<TimelineRow, { kind: "html-render" }>) => ReactNode) | undefined;
  /** Unset, expanded rows read detail and command output from the environment. */
  turnItemSource: TurnItemSource | undefined;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  workflowOpening: WorkflowOpening | null;
  /** Absent hides "Fork from this response", as in the guest view. */
  onForkFromRun:
    | ((input: { readonly sourceThreadId: ThreadId; readonly runId: RunId }) => Promise<void>)
    | undefined;
  onToggleTurnFold: (runId: RunId) => void;
  onToggleAttemptFold: (attemptId: RunAttemptId) => void;
  onFileOpen: (attachment: ChatFileAttachment) => void;
  onFileDownload: (attachment: ChatFileAttachment) => void;
  openPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
  onToggleWorkGroup: (groupId: string, anchorKey: string) => void;
  onToggleWorkEntry: (anchorKey: string, collapsed: boolean) => void;
  onCancelWorktreeSetup: (() => void) | null;
  retryableWorkspacePreparationRunIds: ReadonlySet<RunId>;
  onRetryWorkspacePreparation: ((runId: RunId) => void) | null;
  onWorktreeSetupWorkLocally: (() => void) | null;
  onOpenWorktreeSetupTerminal: ((terminalId: string) => void) | null;
  workGroupViewState: WorkGroupViewState;
}

export interface TimelineRowActivityState {
  isWorking: boolean;
  isCompacting: boolean;
  isRevertingCheckpoint: boolean;
  awaitingUser: boolean;
  isPreparingWorktree: boolean;
  latestRunId: RunId | null;
  backgroundWorktreeSetup: WorktreeSetupSnapshot | null;
  liveAnswerPreview: string | null;
}

export const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

export const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

export interface WorkGroupViewState {
  scrollPositions: Map<string, WorkGroupScrollAnchor>;
  expandedEntries: Set<string>;
}

export const WorkGroupViewCtx = createContext<{
  state: WorkGroupViewState;
  onToggleEntry: (collapsed: boolean) => void;
} | null>(null);

export type TimelineWorkEntry = Extract<
  MessagesTimelineRow,
  { kind: "work" }
>["groupedEntries"][number];

export type TimelineRow = MessagesTimelineRow;
