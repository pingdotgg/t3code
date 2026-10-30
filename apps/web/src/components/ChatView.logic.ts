import { type OrchestrationV2ProviderTurn, type RunAttemptId } from "@t3tools/contracts";
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { checkpointFileTotals } from "@t3tools/client-runtime/state/thread-checkpoints";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Option from "effect/Option";
import type { SetStateAction } from "react";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "../providerModels";
import { sanitizeThreadErrorMessage } from "@t3tools/client-runtime/errors";
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
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import * as DateTime from "effect/DateTime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { videoMimeType } from "@t3tools/shared/video";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
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
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells, environmentThreadDetails } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import {
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import {
  previewAnnotationContextLabel,
  reviewCommentContextLabel,
  terminalContextReference,
} from "../lib/composerContextRecords";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { derivePhase, type TimelineEntry } from "../session-logic";
import type { PreviewMiniPlayerSource } from "../previewMiniPlayerStore";
import type { DesktopPreviewOverlay } from "../previewStateStore";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

type ThreadProjection = EnvironmentThread["projection"];
type ThreadStructureRow = ThreadStructure["visibleTurnItems"][number];

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

interface ProactivePanelObservation {
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

export function resolveWorktreeSetupProgress(input: {
  threadId: ThreadId;
  localPreparing: boolean;
  runStatus: NonNullable<Thread["latestRun"]>["status"] | undefined;
  latest: WorktreeSetupSnapshot | null | undefined;
  held: WorktreeSetupSnapshot | null;
}) {
  const latest = input.latest?.threadId === input.threadId ? input.latest : null;
  const held = input.held?.threadId === input.threadId ? input.held : null;
  const snapshot = latest && (!held || latest.sequence >= held.sequence) ? latest : held;
  return {
    snapshot,
    isPreparingWorktree:
      input.localPreparing ||
      input.runStatus === "preparing" ||
      (snapshot?.phase === "running" && !worktreeSetupAgentStarted(snapshot)),
  };
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
  hasWorktreeSetupCard?: boolean;
}): boolean {
  if (input.hasWorktreeSetupCard) {
    return false;
  }
  if (input.backgroundSubmissionPending) {
    return true;
  }
  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

/** Remounting or initially emptying LegendList flashes the chat pane, even for cached threads. */
export type HeldThreadTimeline<T extends readonly unknown[]> = {
  threadKey: string | null;
  entries: T;
};

const MAX_REMEMBERED_THREAD_TIMELINES = 16;

let rememberedThreadTimelines = new Map<string, HeldThreadTimeline<readonly unknown[]>>();
let rememberedThreadTimelineOrder: string[] = [];

function rememberThreadTimelineEntries(held: HeldThreadTimeline<readonly unknown[]>): void {
  if (held.threadKey === null) {
    return;
  }
  rememberedThreadTimelines.set(held.threadKey, held);
  rememberedThreadTimelineOrder = [
    ...rememberedThreadTimelineOrder.filter((key) => key !== held.threadKey),
    held.threadKey,
  ];
  while (rememberedThreadTimelineOrder.length > MAX_REMEMBERED_THREAD_TIMELINES) {
    const evicted = rememberedThreadTimelineOrder.shift();
    if (evicted !== undefined) {
      rememberedThreadTimelines.delete(evicted);
    }
  }
}

export function rememberReadyThreadTimeline<T extends readonly unknown[]>(
  held: HeldThreadTimeline<T>,
): void {
  if (held.threadKey === null || held.entries.length === 0) {
    return;
  }
  rememberThreadTimelineEntries(held);
}

export function peekRememberedThreadTimeline<T extends readonly unknown[]>(
  threadKey: string | null,
): T | null {
  if (threadKey === null) {
    return null;
  }
  return (rememberedThreadTimelines.get(threadKey)?.entries as T | undefined) ?? null;
}

export function resetHeldThreadTimeline(): void {
  rememberedThreadTimelines = new Map();
  rememberedThreadTimelineOrder = [];
}

export function resolveThreadSwitchTimeline<T extends readonly unknown[]>(input: {
  loading: boolean;
  activeThreadKey: string | null;
  nextEntries: T;
  rememberedForActive?: T | null;
}): T {
  if (input.nextEntries.length > 0) {
    return input.nextEntries;
  }

  const rememberedForActive =
    input.rememberedForActive ?? peekRememberedThreadTimeline<T>(input.activeThreadKey);
  if (input.loading && rememberedForActive !== null && rememberedForActive.length > 0) {
    return rememberedForActive;
  }

  return input.nextEntries;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  const timestamp = DateTime.makeUnsafe(draftThread.createdAt);
  return presentThreadShell(draftThread.environmentId, {
    id: threadId,
    projectId: draftThread.projectId,
    title: "New thread",
    providerInstanceId: fallbackModelSelection.instanceId,
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

export function resolveComposerProviderSelection(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  lockedProvider: ProviderDriverKind | null;
  lockedInstanceId: ProviderInstanceId | null | undefined;
}) {
  const requestedInstanceId = input.candidateInstanceIds.find(
    (candidate) => candidate != null && candidate !== NO_PROVIDER_MODEL_SELECTION.instanceId,
  );
  const requestedDriverKind =
    input.lockedProvider ??
    input.entries.find((entry) => entry.instanceId === requestedInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey = input.lockedProvider
    ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey ?? null)
    : null;
  // Missing metadata must not move Antigravity history into another Google profile.
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedContinuationGroupKey === null;
  const compatibleEntries = input.entries.filter(
    (entry) =>
      (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === input.lockedInstanceId),
  );
  const selectedProviderEntry =
    input.candidateInstanceIds
      .map((candidate) =>
        compatibleEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
        ),
      )
      .find((entry) => entry !== undefined) ??
    resolveSelectableProviderInstanceEntry(
      compatibleEntries.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined);
  const unavailableProviderInstanceId = selectedProviderEntry
    ? undefined
    : input.lockedProvider
      ? (input.lockedInstanceId ?? requestedInstanceId)
      : requestedInstanceId;
  return {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  };
}

export function resolveComposerInteractionMode(input: {
  planModeEnabled: boolean;
  provider: Pick<ServerProvider, "showInteractionModeToggle"> | null | undefined;
  interactionMode: ProviderInteractionMode;
}): { enabled: boolean; interactionMode: ProviderInteractionMode } {
  const enabled =
    input.planModeEnabled &&
    input.provider != null &&
    input.provider.showInteractionModeToggle !== false;
  return {
    enabled,
    interactionMode: enabled ? input.interactionMode : "default",
  };
}

export function getAntigravitySendBlockReason(
  provider:
    | Pick<ServerProvider, "driver" | "installed" | "auth" | "models" | "status">
    | null
    | undefined,
  model: string,
): string | null {
  if (provider?.driver !== "antigravity") return null;
  if (!provider.installed) {
    return "Install Antigravity in provider settings before sending.";
  }
  if (provider.auth.status === "unauthenticated") {
    return "Sign in to Antigravity in provider settings before sending.";
  }
  const slug = model.trim();
  if (slug.length === 0) return "Choose an Antigravity model before sending.";
  if (provider.auth.status === "unknown") return null;
  if (provider.models.length === 0) {
    return "Refresh Antigravity models in provider settings before sending.";
  }
  if (
    provider.status === "ready" &&
    slug !== ANTIGRAVITY_DEFAULT_MODEL &&
    !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
  ) {
    return "That Antigravity model is no longer available. Choose another model.";
  }
  return null;
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

// Null identifies the project checkout when a launch or session is known.
export function resolveTerminalWorktreePath(input: {
  launchContext: { readonly worktreePath: string | null } | null;
  summary: { readonly worktreePath: string | null } | null;
  threadWorktreePath: string | null;
}): string | null {
  if (input.launchContext !== null) return input.launchContext.worktreePath;
  if (input.summary !== null) return input.summary.worktreePath;
  return input.threadWorktreePath;
}

export async function resolveFileAttachmentUrl(input: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: AssetCreateUrlInput;
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<string> {
  const { attachment } = input;
  const result = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid attachment URL.");
  return url;
}

export async function prepareRevertedMessageAttachments(input: {
  message: ChatMessage;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: Parameters<typeof resolveFileAttachmentUrl>[0]["createAssetUrl"];
}): Promise<File[]> {
  return Promise.all(
    (input.message.attachments ?? []).map(async (attachment) => {
      if (attachment.type !== "image" && attachment.type !== "file") {
        throw new Error("This message has an attachment that cannot be restored.");
      }
      const result = await input.createAssetUrl({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
      if (url === null) throw new Error("The environment returned an invalid attachment URL.");
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not restore attachment: ${attachment.name}`);
      return new File([await response.blob()], attachment.name, { type: attachment.mimeType });
    }),
  );
}

export function timelineHasEphemeralPreviewUrls(
  entries: ReadonlyArray<Pick<TimelineEntry, "kind"> & { message?: ChatMessage }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.message !== undefined &&
      collectUserMessageBlobPreviewUrls(entry.message).length > 0,
  );
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export { readFileAsDataUrl } from "../lib/imageCompression";

export { resolveSendEnvMode } from "@t3tools/shared/projectSettings";

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  existingAttachmentCount?: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineContextReferences(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      (options.existingAttachmentCount ?? 0) > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// Composer autofocus makes focus unreliable as draft intent.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

// A typed `/compact`, with or without instructions, is already the compaction. Queueing a
// bare one ahead of it would run an uninstructed compaction first and charge for two.
const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

// Remember non-Git checkouts to avoid flashing the branch strip before delayed Git status arrives.
const sessionCheckoutIsRepo = new Map<string, boolean>();

function checkoutIsRepoKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

export function rememberCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string,
  isRepo: boolean,
): void {
  sessionCheckoutIsRepo.set(checkoutIsRepoKey(environmentId, cwd), isRepo);
}

export function recallCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string | null,
): boolean | undefined {
  return cwd === null
    ? undefined
    : sessionCheckoutIsRepo.get(checkoutIsRepoKey(environmentId, cwd));
}

function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

// Imported history lacks a session until its first prompt; resolve its instance before locking the driver.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.runtime?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  // Missing catalog entries must not switch a started thread's driver.
  const threadProvider =
    input.providers.find((provider) => provider.instanceId === input.threadProvider)?.driver ??
    input.threadProvider;
  const selectedProvider =
    input.providers.find((provider) => provider.instanceId === input.selectedProvider)?.driver ??
    input.selectedProvider;
  const narrowedThreadProvider =
    threadProvider && isProviderDriverKind(threadProvider) ? threadProvider : null;
  const narrowedSelectedProvider =
    selectedProvider && isProviderDriverKind(selectedProvider) ? selectedProvider : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  hasStartedSession: boolean;
  supportsProviderSwitchingViaHandoff?: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId ||
    input.supportsProviderSwitchingViaHandoff === true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to switch providers",
    description: "This thread does not support switching providers after it has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadShells.threadShellAtom(threadRef);
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: threadAtom,
    predicate: threadHasStarted,
    timeoutMs,
  });
}

export async function waitForRevertedMessage(
  threadRef: ScopedThreadRef,
  turnCount: number,
  requestId: CommandId,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
): Promise<void> {
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
  const initial = readProjection();
  const providerThreadId = initial?.thread.activeProviderThreadId;
  const initialProviderThread = initial?.providerThreads.find(
    (providerThread) => providerThread.id === providerThreadId,
  );
  const initialProviderThreadIds = new Set(initial?.providerThreads.map((thread) => thread.id));
  // Paging can omit the source run. Rollback commits the entire settled suffix atomically.
  const witness = initial?.runs.reduce<(typeof initial.runs)[number] | undefined>((latest, run) => {
    if (
      run.ordinal <= turnCount ||
      (run.status !== "completed" &&
        run.status !== "interrupted" &&
        run.status !== "failed" &&
        run.status !== "cancelled")
    )
      return latest;
    return latest === undefined || run.ordinal > latest.ordinal ? run : latest;
  }, undefined);
  if (witness === undefined) {
    throw new Error("The thread has changed. Select a message to rewind again.");
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.providerThreads.some(
          (providerThread) =>
            (providerThread.id === providerThreadId ||
              // Claude resets to a fresh root session when rewinding to thread start.
              (turnCount === 0 &&
                providerThread.ownerNodeId === null &&
                providerThread.appThreadId === initial?.thread.id &&
                providerThread.providerInstanceId === initialProviderThread?.providerInstanceId &&
                !initialProviderThreadIds.has(providerThread.id))) &&
            providerThread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
        ) &&
        thread.runs.some((run) => run.id === witness.id && run.status === "rolled_back")
      )
        finish();
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

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

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: {
    preparingWorktree?: boolean;
    latestUserMessageId?: ChatMessage["id"] | null;
    submissionIntent?: ComposerSubmissionIntent;
  },
): LocalDispatchSnapshot {
  const latestRun = activeThread?.latestRun ?? null;
  const runtime = activeThread?.runtime ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    latestUserMessageId: options?.latestUserMessageId ?? null,
    latestRunId: latestRun?.runId ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    runtimeStatus: runtime?.status ?? null,
    runtimeUpdatedAt: runtime?.updatedAt ?? null,
  };
}

/** Projection messages can precede visible turn items by one event; evict optimistic rows only when
 * visible. */
export function deriveCommittedServerUserMessageIds(
  visibleTurnItems: ReadonlyArray<ThreadStructureRow>,
): ReadonlySet<ChatMessage["id"]> {
  return new Set(
    visibleTurnItems.flatMap((row) =>
      row.item.type === "user_message" ? [row.item.messageId] : [],
    ),
  );
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestRun: Thread["latestRun"] | null;
  latestUserMessageId?: ChatMessage["id"] | null;
  runtime: Thread["runtime"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (input.phase === "connecting" || derivePhase(input.runtime ?? null) === "connecting") {
    return false;
  }

  const latestRun = input.latestRun ?? null;
  const runtime = input.runtime ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== (input.latestUserMessageId ?? null);
  const latestRunChanged =
    input.localDispatch.latestRunId !== (latestRun?.runId ?? null) ||
    input.localDispatch.latestRunRequestedAt !== (latestRun?.requestedAt ?? null) ||
    input.localDispatch.latestRunStartedAt !== (latestRun?.startedAt ?? null) ||
    input.localDispatch.latestRunCompletedAt !== (latestRun?.completedAt ?? null);

  if (input.phase === "running") {
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestRunChanged) {
      return false;
    }
    if (latestRun?.startedAt === null || latestRun === null) {
      return false;
    }
    if (
      runtime?.activeRunId !== null &&
      runtime?.activeRunId !== undefined &&
      latestRun?.runId !== runtime.activeRunId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestRunChanged ||
    input.localDispatch.runtimeStatus !== (runtime?.status ?? null) ||
    input.localDispatch.runtimeUpdatedAt !== (runtime?.updatedAt ?? null)
  );
}

// Returning to the window should land the caret in the composer, so the reader can type right
// away. The exceptions are places where focus is deliberate: another text field, a terminal in
// the drawer or the right panel, an open dialog, menu, or popup, or a region or sidebar row
// reached from the keyboard. A plain focused button or a clicked row yields to the composer.
export function shouldRefocusComposerOnWindowFocus(
  activeElement:
    | (Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean })
    | null,
): boolean {
  if (activeElement === null || activeElement.tagName === "BODY") return true;
  if (
    activeElement.tagName === "INPUT" ||
    activeElement.tagName === "TEXTAREA" ||
    activeElement.tagName === "SELECT" ||
    activeElement.tagName === "IFRAME" ||
    activeElement.tagName === "WEBVIEW" ||
    activeElement.isContentEditable === true ||
    activeElement.getAttribute("role") === "textbox"
  ) {
    return false;
  }
  return (
    activeElement.closest(
      '[data-workspace-area]:focus-visible, [role="treeitem"]:focus-visible, [role="dialog"], [role="alertdialog"], [role="application"], [role="menu"], [role="listbox"], [data-slot$="-popup"], [data-terminal-owner]',
    ) === null
  );
}

export interface PlanFollowUpComposerSnapshot {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly environmentContexts: ReadonlyArray<EnvironmentContextRecord>;
}

export function restorePlanFollowUpComposer(input: {
  readonly snapshot: PlanFollowUpComposerSnapshot;
  readonly writePrompt: (prompt: string) => void;
  readonly writeTerminalContexts: (contexts: ReadonlyArray<TerminalContextDraft>) => void;
  readonly writeReviewComments: (comments: ReadonlyArray<ReviewCommentContext>) => void;
  readonly writePreviewAnnotations: (annotations: ReadonlyArray<PreviewAnnotationPayload>) => void;
  readonly writeThreadContexts: (records: ReadonlyArray<ThreadContextRecord>) => void;
  readonly writeEnvironmentContexts: (records: ReadonlyArray<EnvironmentContextRecord>) => void;
  readonly resetCursor: (options: {
    cursor: number;
    prompt: string;
    detectTrigger: boolean;
  }) => void;
}): void {
  input.writePrompt(input.snapshot.prompt);
  input.writeTerminalContexts(input.snapshot.terminalContexts);
  input.writeReviewComments(input.snapshot.reviewComments);
  input.writePreviewAnnotations(input.snapshot.previewAnnotations);
  input.writeThreadContexts(input.snapshot.threadContexts);
  input.writeEnvironmentContexts(input.snapshot.environmentContexts);
  input.resetCursor({
    cursor: collapseExpandedComposerCursor(input.snapshot.prompt, input.snapshot.prompt.length),
    prompt: input.snapshot.prompt,
    detectTrigger: true,
  });
}

/** Includes the annotation screenshot only within the attachment cap; exceeding it rejects the whole turn. */
export function mergeDirectPreviewAnnotation(input: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly fileCount: number;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly direct:
    | {
        readonly annotation: PreviewAnnotationPayload;
        readonly image: ComposerImageAttachment | null;
      }
    | undefined;
}): {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
} {
  const { direct } = input;
  if (!direct) return { images: input.images, previewAnnotations: input.previewAnnotations };
  const imageAlreadyAttached =
    direct.image !== null && input.images.some((image) => image.id === direct.image?.id);
  const imageAppended =
    direct.image !== null &&
    !imageAlreadyAttached &&
    input.images.length + input.fileCount < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
  const images = direct.image && imageAppended ? [...input.images, direct.image] : input.images;
  const previewAnnotations = input.previewAnnotations.some(
    (annotation) => annotation.id === direct.annotation.id,
  )
    ? input.previewAnnotations
    : [
        ...input.previewAnnotations,
        {
          ...direct.annotation,
          screenshot:
            direct.annotation.screenshot && (imageAppended || imageAlreadyAttached)
              ? { ...direct.annotation.screenshot, dataUrl: "" }
              : null,
        },
      ];
  return { images, previewAnnotations };
}

export { isThreadWokeUnseen } from "@t3tools/client-runtime/state/thread-settled";

export function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

export function isCompactCommandMessage(message: ChatMessage): boolean {
  const text = message.text.trim().toLowerCase();
  return message.role === "user" && text === "/compact" && !message.attachments?.length;
}

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
export type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

export function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function releaseChatTimelineAnchor<T extends { readonly messageId: MessageId | null }>(
  current: T,
): T {
  return current.messageId === null ? current : { ...current, messageId: null };
}

// The factories below build functions ChatView calls during render, or hands
// to ChatComposer, which can call them after an await. They live outside the
// component so each closure keeps only its inputs, not a whole render scope
// (see useStableCallback), while still acting on the render that made them.

/** Records a thread error in local state, keyed by the route the making render saw. */
export function makeThreadErrorSetter(input: {
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly draftId: DraftId | null;
  readonly serverThreadRef: ScopedThreadRef | null;
  readonly setLocalServerErrorsByThreadKey: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
  readonly setLocalDraftErrorsByDraftId: (
    update: SetStateAction<Record<string, LocalThreadErrorEntry>>,
  ) => void;
}) {
  return (targetThreadId: ThreadId | null, error: string | null) => {
    if (!targetThreadId) return;
    const nextError = sanitizeThreadErrorMessage(error);
    const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
    const { routeThreadRef, serverThreadRef } = input;
    if (
      serverThreadRef &&
      targetThreadId === routeThreadRef.threadId &&
      serverThreadRef.environmentId === routeThreadRef.environmentId &&
      serverThreadRef.threadId === targetThreadId
    ) {
      input.setLocalServerErrorsByThreadKey((existing) => {
        if ((existing[input.routeThreadKey]?.message ?? null) === nextError) {
          return existing;
        }
        return { ...existing, [input.routeThreadKey]: nextEntry };
      });
      return;
    }
    const localDraftErrorKey = input.draftId ?? targetThreadId;
    input.setLocalDraftErrorsByDraftId((existing) => {
      if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
        return existing;
      }
      return { ...existing, [localDraftErrorKey]: nextEntry };
    });
  };
}

/** Why the model picker should disable a model, or null when it can be chosen. */
export function makeModelDisabledReason(
  context: Omit<
    Parameters<typeof getStartedThreadModelChangeBlockReason>[0],
    "nextModelSelection"
  > | null,
) {
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    if (!context) return null;
    const reason = getStartedThreadModelChangeBlockReason({
      ...context,
      nextModelSelection: { instanceId, model },
    });
    return reason ? `${reason.description} Start a new thread to use this model.` : null;
  };
}

/** What the composer held when the user pressed send, after a direct annotation merged in. */
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
export function snapshotComposerSend(contents: ComposerSendContents) {
  const images = [...contents.images];
  const files = [...contents.files];
  const terminalContexts = [...contents.sendableTerminalContexts];
  return {
    images,
    files,
    attachments: [...images, ...files],
    terminalContexts,
    previewAnnotations: [...contents.previewAnnotations],
    reviewComments: [...contents.reviewComments],
    threadContexts: [...contents.threadContexts],
    environmentContexts: [...contents.environmentContexts],
    messageText: contents.terminalContexts
      .filter((context) => !terminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        contents.prompt,
      )
      .trim(),
  };
}

export type ComposerSendSnapshot = ReturnType<typeof snapshotComposerSend>;

/** How a composer send dispatches: where it runs and whether it waits behind other work. */
export function planComposerTurn(input: {
  readonly messageText: string;
  readonly sendQueuesBehindSetup: boolean;
  readonly isServerThread: boolean;
  readonly activeMessageCount: number;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly worktreePath: string | null;
  readonly activeThreadBranch: string | null;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly phase: SessionPhase;
  readonly dispatchMode: ComposerDispatchMode;
}) {
  const isFirstMessage =
    !input.sendQueuesBehindSetup && (!input.isServerThread || input.activeMessageCount === 0);
  const shouldCreateWorktree =
    isFirstMessage && input.sendEnvMode === "worktree" && !input.worktreePath;
  // A stale Claude session compacts before this message so the turn does not re-read the
  // old history. The message queues behind the /compact run, since steering into it is
  // rejected.
  const compactBeforeSend =
    input.resumeCompactionTokens !== null &&
    !input.keepFullHistory &&
    !COMPACT_COMMAND_PATTERN.test(input.messageText);
  return {
    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    missingWorktreeBaseBranch: shouldCreateWorktree && !input.activeThreadBranch,
    baseBranchForWorktree: shouldCreateWorktree ? input.activeThreadBranch : null,
    compactBeforeSend,
    turnDispatchMode:
      compactBeforeSend || input.sendQueuesBehindSetup ? ("queue" as const) : input.dispatchMode,
    shouldQueueBehindActiveRun:
      compactBeforeSend ||
      input.sendQueuesBehindSetup ||
      (input.phase === "running" && input.dispatchMode === "queue"),
  };
}

/**
 * The attachment ids a message's context records bind to: the upload id the
 * server returned, or the local id on the data-URL path.
 */
export function boundAttachmentIds(
  turnAttachments: ReadonlyArray<{ readonly id?: string | undefined }>,
  attachments: ReadonlyArray<{ readonly id: string }>,
): string[] {
  return turnAttachments.map((attachment, index) =>
    "id" in attachment && attachment.id !== undefined ? attachment.id : attachments[index]!.id,
  );
}

export function withMessageContext(input: {
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
}): { readonly text: string; readonly context?: OrchestrationMessageContext } {
  const { text, context } = input;
  if (context === undefined) return { text };
  return { text, context };
}

/** The attachments the optimistic user row shows before the server echoes the message. */
export function optimisticMessageAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
) {
  return attachments.map((attachment) =>
    attachment.type === "image"
      ? {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: attachment.previewUrl,
          ...(attachment.source ? { source: attachment.source } : {}),
        }
      : {
          type: "file" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          downloadable: false,
          ...(attachment.source ? { source: attachment.source } : {}),
        },
  );
}

/** Fallback title sources for a message with no text of its own. */
export function sendTitleFallbackLabels(snapshot: ComposerSendSnapshot) {
  const terminalContext = snapshot.terminalContexts[0];
  const reviewComment = snapshot.reviewComments[0];
  const previewAnnotation = snapshot.previewAnnotations[0];
  return [
    terminalContext ? formatTerminalContextLabel(terminalContext) : undefined,
    reviewComment ? `Review: ${reviewCommentContextLabel(reviewComment)}` : undefined,
    previewAnnotation ? previewAnnotationContextLabel(previewAnnotation) : undefined,
  ];
}

/**
 * A thread shell built from its loaded detail, for direct links that hydrate the detail first.
 * `updatedAt` and `lastVisitedAt` are passed live: the thread structure leaves them out.
 */
export function presentThreadShellFromProjection(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projection: ThreadStructure,
  live: {
    readonly updatedAt: ThreadProjection["updatedAt"];
    readonly lastVisitedAt: ThreadProjection["thread"]["lastVisitedAt"];
  },
) {
  const { updatedAt, lastVisitedAt } = live;
  const latestRun = deriveLatestThreadRun(projection);
  const runtime = deriveThreadRuntime({ ...projection, updatedAt });
  const pendingRuntimeRequest =
    projection.runtimeRequests.findLast((request) => request.status === "pending") ?? null;
  // Direct links can hydrate detail before the thread enters the shell index.
  return {
    ...presentThreadShell(environmentId, {
      ...projection.thread,
      lastVisitedAt,
      latestRunId: latestRun?.runId ?? null,
      activeRunId: runtime?.activeRunId ?? null,
      status: runtime?.status ?? "idle",
      pendingRuntimeRequest,
      latestVisibleMessage: null,
      latestUserMessageAt:
        projection.messages.findLast((message) => message.role === "user")?.updatedAt ?? null,
      hasActionableProposedPlan: projection.plans.some(
        (plan) => plan.kind === "proposed_plan" && plan.status === "active",
      ),
      providerInstanceHistory: [
        ...new Set(
          projection.providerThreads
            .filter((thread) => thread.appThreadId === threadId && thread.ownerNodeId === null)
            .map((thread) => thread.providerInstanceId),
        ),
      ],
      goal:
        projection.providerThreads.find(
          (thread) => thread.id === projection.thread.activeProviderThreadId,
        )?.goal ?? null,
      itemCount: projection.turnItems.length,
      visibleItemCount: projection.visibleTurnItems.length,
      updatedAt,
    }),
    latestRun,
    runtime,
  };
}

/** Background work the provider still runs after the latest run ended. */
export function deriveThreadPendingBackgroundTasks(projection: ThreadStructure | null) {
  if (projection === null) return [];
  const sessionError =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(projection.runs, projection.turnItems, sessionError) ??
    latestUnheldRun(projection.runs);
  return [
    ...derivePendingBackgroundWork({
      latestRun,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  ];
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(projection: ThreadStructure | null) {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

/**
 * Changes when the agent may have changed the workspace, so file views refresh. File tools are
 * explicit; completed commands are included because a shell command can mutate the workspace
 * without reporting the paths it touched.
 */
export function deriveWorkspaceMutationId(
  visibleTurnItems: ReadonlyArray<ThreadStructureRow>,
  latestCheckpointCompletedAt: string | null,
) {
  let itemId: string | null = null;
  for (let index = visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = visibleTurnItems[index]?.item;
    if (!item) continue;
    if (item.type !== "command_execution" && item.type !== "file_change") continue;
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
      continue;
    }
    itemId = item.id;
    break;
  }
  return itemId === null && latestCheckpointCompletedAt === null
    ? null
    : JSON.stringify([itemId, latestCheckpointCompletedAt]);
}
