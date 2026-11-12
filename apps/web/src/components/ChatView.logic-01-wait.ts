import { COMPACT_COMMAND_PATTERN, getStartedThreadModelChangeBlockReason, threadHasStarted } from "./ChatView.logic-02-resolve.ts";
import type { ComposerSendContents, ComposerSendSnapshot, LocalDispatchSnapshot, LocalThreadErrorEntry, PlanFollowUpComposerSnapshot, ThreadProjection, ThreadStructureRow } from "./ChatView.logic-03-thread.ts";
import { type OrchestrationV2ProviderTurn, type RunAttemptId } from "@t3tools/contracts";
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
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
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== (input.latestUserMessageId ?? null);
  if (input.phase === "connecting" || derivePhase(input.runtime ?? null) === "connecting") {
    // A message queued behind other work, such as an idle compaction the shell hides, has landed.
    return input.runtime?.status === "queued" && latestUserMessageChanged;
  }

  const latestRun = input.latestRun ?? null;
  const runtime = input.runtime ?? null;
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
      '[data-workspace-area]:focus-visible, [data-sidebar-row]:focus-visible, [role="dialog"], [role="alertdialog"], [role="application"], [role="menu"], [role="listbox"], [data-slot$="-popup"], [data-terminal-owner]',
    ) === null
  );
}

export function restorePlanFollowUpComposer(input: {
  readonly snapshot: PlanFollowUpComposerSnapshot;
  readonly draftHasUserContent: boolean;
  readonly routeIsCurrent: boolean;
  readonly writeComposerRefs: (snapshot: PlanFollowUpComposerSnapshot) => void;
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
  if (input.draftHasUserContent) return;
  if (input.routeIsCurrent) input.writeComposerRefs(input.snapshot);
  input.writePrompt(input.snapshot.prompt);
  input.writeTerminalContexts(input.snapshot.terminalContexts);
  input.writeReviewComments(input.snapshot.reviewComments);
  input.writePreviewAnnotations(input.snapshot.previewAnnotations);
  input.writeThreadContexts(input.snapshot.threadContexts);
  input.writeEnvironmentContexts(input.snapshot.environmentContexts);
  if (!input.routeIsCurrent) return;
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

