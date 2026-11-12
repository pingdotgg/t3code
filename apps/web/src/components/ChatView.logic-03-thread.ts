import { snapshotComposerSend } from "./ChatView.logic-01-wait.ts";
import { checkpointFileTotals } from "@t3tools/client-runtime/state/thread-checkpoints";
import type {
  EnvironmentThread,
  ThreadStructure,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type ChatFileAttachment,
  type CommandId,
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type PreviewAnnotationPayload,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type EnvironmentContextRecord,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type RunId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import {
  type ChatMessage,
  isImageAttachment,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  type DraftThreadState,
} from "../composerDraftStore";
import * as Schema from "effect/Schema";
import {
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { derivePhase, type TimelineEntry } from "../session-logic";
import type { PreviewMiniPlayerSource } from "../previewMiniPlayerStore";
import type { DesktopPreviewOverlay } from "../previewStateStore";
import type { RightPanelSurface } from "../rightPanelStore";

export type ThreadProjection = EnvironmentThread["projection"];
export type ThreadStructureRow = ThreadStructure["visibleTurnItems"][number];

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export function agentControlledBrowserCloseConfirmation(
  surfaces: readonly RightPanelSurface[],
  desktopByTabId: Readonly<Record<string, Pick<DesktopPreviewOverlay, "controller"> | undefined>>,
): string | null {
  const activeBrowserCount = surfaces.filter(
    (surface) =>
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      desktopByTabId[surface.resourceId]?.controller === "agent",
  ).length;
  if (activeBrowserCount === 0) return null;
  if (activeBrowserCount === 1) {
    return [
      "Close browser while the agent is using it?",
      "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
    ].join("\n");
  }
  return [
    `Close ${activeBrowserCount} browsers while the agent is using them?`,
    "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
  ].join("\n");
}

export function shouldRenderPreviewMiniPlayer(
  source: PreviewMiniPlayerSource | null,
  renderedRightPanelSurface: RightPanelSurface | null,
): boolean {
  if (source === null) return false;
  if (source.kind === "browser") {
    return !(
      renderedRightPanelSurface?.kind === "preview" &&
      renderedRightPanelSurface.resourceId === source.tabId
    );
  }
  return !(
    renderedRightPanelSurface?.kind === "device" &&
    renderedRightPanelSurface.target?.hostId === source.hostId &&
    renderedRightPanelSurface.target.deviceId === source.deviceId
  );
}

export function shouldOpenProactivePullRequest(
  previousTargetKey: string | null | undefined,
  targetKey: string | null,
): boolean {
  return targetKey !== null && targetKey !== previousTargetKey;
}

export interface ProactivePanelObservation {
  threadKey: string;
  runningTurnId: RunId | null | undefined;
  targetKey: string | null | undefined;
  userActionTurnId: RunId | null;
  userActionRevision: number;
}

export function observeProactivePanelUserChoice(
  previous: ProactivePanelObservation | null,
  input: { threadKey: string; runningTurnId: RunId | null; userActionRevision: number },
): ProactivePanelObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newTurn =
    sameThread && input.runningTurnId !== null && input.runningTurnId !== previous.userActionTurnId;
  return {
    threadKey: input.threadKey,
    runningTurnId: sameThread ? previous.runningTurnId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionTurnId: input.runningTurnId ?? (sameThread ? previous.userActionTurnId : null),
    userActionRevision:
      !sameThread || newTurn ? input.userActionRevision : previous.userActionRevision,
  };
}

export function shouldRetargetThreadPullRequestPanel(
  previous: ThreadLinkedPullRequest | null,
  current: ThreadLinkedPullRequest | null,
  surface: RightPanelSurface | null,
): boolean {
  if (previous === null || current === null || surface?.kind !== "pull-request") return false;
  const previousRepository = previous.repository.toLowerCase();
  return (
    (previous.projectId !== current.projectId ||
      previousRepository !== current.repository.toLowerCase() ||
      previous.number !== current.number) &&
    surface.projectId === previous.projectId &&
    surface.repository.toLowerCase() === previousRepository &&
    surface.number === previous.number
  );
}

export function shouldOpenProactiveTurnDiff(input: {
  previousRunningTurnId: RunId | null | undefined;
  runningTurnId: RunId | null;
  settledTurnId: RunId | null;
  turnCompleted: boolean;
}): boolean {
  return (
    input.runningTurnId === null &&
    input.turnCompleted &&
    input.settledTurnId !== null &&
    (input.previousRunningTurnId === undefined ||
      input.settledTurnId === input.previousRunningTurnId)
  );
}

export function resolveProactiveTurnDiffAction(input: {
  checkpoint: Pick<TurnDiffSummary, "status" | "files" | "filesTotal"> | undefined;
  isGitRepo: boolean | undefined;
}): "defer" | "ignore" | "open" {
  if (input.checkpoint === undefined || input.checkpoint.status === "missing") return "defer";
  if (input.isGitRepo === undefined) return "defer";
  if (
    !input.isGitRepo ||
    input.checkpoint.status !== "ready" ||
    input.checkpoint.files.length === 0
  ) {
    return "ignore";
  }
  const totals = checkpointFileTotals(input.checkpoint);
  return totals.count >= 3 || totals.additions + totals.deletions >= 50 ? "open" : "ignore";
}

/** Mark reactivated Diff tabs to preserve review scope. Already-active tabs must not leave a marker for
 * the next open. */
export function resolveExplicitDiffOpenOnActivate(input: {
  readonly surfaceKind: RightPanelSurface["kind"];
  readonly diffOpen: boolean;
  readonly activeThreadRef: ScopedThreadRef;
}): ScopedThreadRef | null {
  return input.surfaceKind === "diff" && !input.diffOpen ? input.activeThreadRef : null;
}

export function codexArtifactTemplatePromptToAppend(
  currentDraft: string,
  template: CodexArtifactTemplate,
): string | null {
  return appendCodexArtifactTemplateUsePrompt(currentDraft, template) === currentDraft
    ? null
    : codexArtifactTemplateUsePrompt(template);
}

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: RunId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.runId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;
    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export { resolveVisibleWorktreeSetup } from "@t3tools/client-runtime/worktree-setup";

export type HeldThreadTimeline<T extends readonly unknown[]> = {
  threadKey: string | null;
  entries: T;
};

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  latestUserMessageId: ChatMessage["id"] | null;
  latestRunId: RunId | null;
  latestRunRequestedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  runtimeStatus: NonNullable<Thread["runtime"]>["status"] | null;
  runtimeUpdatedAt: string | null;
}

export interface PlanFollowUpComposerSnapshot {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

// A draft typed while the send was in flight is newer and stays. Composer refs and the cursor
// belong to the thread on screen, so they follow only while the follow-up's route is current.
export type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

export interface ComposerSendContents {
  readonly prompt: string;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly sendableTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

/**
 * Copies the composer contents a send dispatches, so a failed send can put the
 * same draft back. Terminal contexts that lost their text are dropped from both
 * the contexts and the prompt's inline references.
 */
export type ComposerSendSnapshot = ReturnType<typeof snapshotComposerSend>;

/** How a composer send dispatches: where it runs and whether it waits behind other work. */
