import { MAX_HIDDEN_MOUNTED_TERMINAL_THREADS } from "./ChatView.logic-03-thread.ts";
import type { HeldThreadTimeline } from "./ChatView.logic-03-thread.ts";
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
import {
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import {
  removeInlineContextReference,
  stripInlineContextReferences,
} from "~/lib/composerContextReferences";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { derivePhase, type TimelineEntry } from "../session-logic";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";

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
export const MAX_REMEMBERED_THREAD_TIMELINES = 16;

export let rememberedThreadTimelines = new Map<string, HeldThreadTimeline<readonly unknown[]>>();
export let rememberedThreadTimelineOrder: string[] = [];

export function rememberThreadTimelineEntries(held: HeldThreadTimeline<readonly unknown[]>): void {
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
    requestedInstanceId,
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
  const pronoun = count === 1 ? "it" : "them";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: `Remove ${pronoun} or re-add ${pronoun} to include terminal output.`,
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: `Re-add ${pronoun} if you want that terminal output included.`,
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
export const COMPACT_COMMAND_PATTERN = /^\/compact(?:\s|$)/i;

export const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

// Remember non-Git checkouts to avoid flashing the branch strip before delayed Git status arrives.
export const sessionCheckoutIsRepo = new Map<string, boolean>();

export function checkoutIsRepoKey(environmentId: EnvironmentId, cwd: string): string {
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

export function threadHasStarted(thread: Thread | null | undefined): boolean {
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

