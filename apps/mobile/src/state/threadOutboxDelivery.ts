import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Dialog from "../components/ui/Dialog";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommand,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { threadFamilyRead, type ThreadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  managedRuntimeModeDenial,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { createDebugLogger } from "../lib/debugLog";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { serializeComposerMessageForServer, uploadedComposerContext } from "../lib/composerContext";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { randomHex } from "../lib/uuid";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../lib/modelOptions";
import {
  retainAcknowledgedThreadMessage,
  forgetAcknowledgedThreadMessage,
} from "./acknowledged-thread-messages";
import { appAtomRegistry } from "./atom-registry";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  clearPendingThreadCreationOutcome,
  pendingThreadCreationOutcomesAtom,
  recordPendingThreadCreationOutcome,
} from "./pending-thread-creation";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { gitEnvironment } from "./git";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadOutboxFailureAction,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment, threadFamilies } from "./threads";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  replaceComposerDraftAttachments,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  threadOutboxShellStatusesAtom,
} from "./use-thread-outbox";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import { workspaceConnections } from "./workspace";

const threadOutboxDebug = createDebugLogger("thread-outbox");

function isRpcClientDecodeDefect(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "RpcClientError"
  ) {
    return false;
  }
  const reason: unknown = (error as { readonly reason?: unknown }).reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "_tag" in reason &&
    reason._tag === "RpcClientDefect"
  );
}

function isOrdinaryThreadOutboxTransportFailure(error: unknown): boolean {
  return shouldRetryThreadOutboxDelivery(error) && !isRpcClientDecodeDefect(error);
}

function logThreadOutboxDeliveryFailure(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly context: Record<string, unknown>;
}): ThreadOutboxFailureAction {
  const action = resolveThreadOutboxFailureAction({
    stage: input.stage,
    error: input.error,
    interrupted: input.interrupted,
  });
  const details = { ...input.context, stage: input.stage, action };
  const ordinaryTransportRetry =
    action === "retry" &&
    !isRpcClientDecodeDefect(input.error) &&
    (input.interrupted ||
      input.stage !== "settings-sync" ||
      shouldRetryThreadOutboxDelivery(input.error));
  if (ordinaryTransportRetry) {
    threadOutboxDebug.log("queued message delivery failed", details);
  } else {
    console.warn("[thread-outbox] queued message delivery failed", details);
  }
  return action;
}

function logThreadOutboxUploadFailure(queuedMessage: QueuedThreadMessage, error: unknown): void {
  const context = {
    environmentId: queuedMessage.environmentId,
    threadId: queuedMessage.threadId,
    messageId: queuedMessage.messageId,
  };
  if (isOrdinaryThreadOutboxTransportFailure(error)) {
    threadOutboxDebug.log("attachment upload failed; retrying", { ...context, error });
  } else {
    console.warn("[thread-outbox] failed to upload attachments", { ...context, error });
  }
}

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export async function prepareQueuedMessageAttachments(queuedMessage: QueuedThreadMessage): Promise<
  | {
      readonly status: "ready";
      readonly prepared: PreparedTurnAttachments;
      readonly persistedMessage: QueuedThreadMessage;
      readonly deliveryRevision: number;
    }
  | { readonly status: "abandoned" }
> {
  if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
    return { status: "abandoned" };
  }
  if (!readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope)) {
    return { status: "abandoned" };
  }
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "abandoned" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const result = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads: true,
    persistUploadedReferences: async (draftAttachments) => {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return "abandon";
      }
      const updatedMessage = { ...queuedMessage, attachments: draftAttachments };
      if (!(await updateThreadOutboxMessage(updatedMessage, revision))) {
        return "abandon";
      }
      persistedMessage = updatedMessage;
      deliveryRevision = revision + 1;
      return "persisted";
    },
  });
  if (
    result.status === "abandoned" ||
    !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
  ) {
    return { status: "abandoned" };
  }
  return { status: "ready", prepared: result, persistedMessage, deliveryRevision };
}

function isQueuedMessagePayloadCurrent(
  message: QueuedThreadMessage,
  expectedRevision: number,
): boolean {
  return (
    threadOutboxRevision(message.messageId) === expectedRevision &&
    Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .flat()
      .some((candidate) => candidate === message)
  );
}

export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
  sequence: number | undefined,
): Promise<"removed" | "edited" | "failed"> {
  clearThreadComposerError(
    scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId),
    queuedMessage.messageId,
  );
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    // Editors can acquire entries during startTurn without bumping revisions; CAS alone would lose unsaved edits.
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    retainAcknowledgedThreadMessage(
      sequence === undefined ? queuedMessage : { ...queuedMessage, sequence },
    );
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    if (!removed) {
      forgetAcknowledgedThreadMessage(queuedMessage);
      threadOutboxDebug.log("delivered message was edited before cleanup", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
      });
      return "edited";
    }
    return "removed";
  } catch (error) {
    forgetAcknowledgedThreadMessage(queuedMessage);
    console.warn("[thread-outbox] failed to remove delivered queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return "failed";
  }
}

export async function removeAcknowledgedExistingThreadMessage(
  queuedMessage: QueuedThreadMessage,
  acknowledgedMessageIds: Set<MessageId>,
): Promise<boolean> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    const removed = await removeThreadOutboxMessage(queuedMessage);
    if (removed) {
      acknowledgedMessageIds.delete(queuedMessage.messageId);
    }
    return removed;
  } catch (error) {
    console.warn("[thread-outbox] failed to remove acknowledged queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return false;
  }
}

export async function recoverEditedCreationAfterDelivery(
  queuedMessage: QueuedThreadMessage,
): Promise<boolean> {
  const kept = Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .find((candidate) => candidate.messageId === queuedMessage.messageId);
  if (!kept) {
    return true;
  }
  const keptRevision = threadOutboxRevision(kept.messageId);
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
  try {
    // Merge before removal to retain file ownership; allow overflow and let send guards require trimming.
    await mergeComposerDraftContent(draftKey, {
      text: kept.text,
      context: kept.context,
      attachments: [],
    });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
      return true;
    }
    if (threadOutboxRevision(kept.messageId) !== keptRevision) {
      return false;
    }
    const existingAttachmentIds = new Set(
      getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
    );
    appendComposerDraftAttachments(
      draftKey,
      kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
      { allowOverflow: true },
    );
    updateComposerDraftSettings(draftKey, {
      ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
      ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
      ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
    });
    // Flush before removal: append only schedules persistence, leaving the queue as the sole durable copy.
    await flushComposerDrafts();
  } catch (error) {
    console.warn("[thread-outbox] could not hand an edited pending task to the composer", error);
    return false;
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  try {
    return await removeThreadOutboxMessage(
      kept,
      keptRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId],
    );
  } catch (error) {
    console.warn("[thread-outbox] could not remove recovered pending task", error);
    return false;
  }
}

export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "deferred" | "blocked" | "retry"> {
  const draftKey = recoveryDraftKey(queuedMessage);
  const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      return "deferred";
    }
    const revision = threadOutboxRevision(queuedMessage.messageId);

    await waitForComposerDraftsLoaded();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    const originalDraft = getComposerDraftSnapshot(draftKey);
    const existingAttachmentIds = new Set(
      originalDraft.attachments.map((attachment) => attachment.id),
    );
    const addedAttachmentCount = queuedMessage.attachments.filter(
      (attachment) => !existingAttachmentIds.has(attachment.id),
    ).length;
    if (existingAttachmentIds.size + addedAttachmentCount > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setThreadComposerError(
        threadKey,
        `Remove attachments from the draft before restoring this message. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        queuedMessage.messageId,
      );
      return "blocked";
    }

    const withdrawError = () => clearThreadComposerError(threadKey, queuedMessage.messageId);
    if (!queuedMessage.creation) {
      setThreadComposerError(threadKey, message, queuedMessage.messageId);
    }
    let mergedDraft: ComposerDraft;
    try {
      stampRecoveryDraftProject(queuedMessage, draftKey);
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        context: queuedMessage.context,
        attachments: queuedMessage.attachments,
      });
    } finally {
      // Capture rollback in finally because merge publishes even on persistence failure; undo must preserve concurrent edits.
      mergedDraft = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot: originalDraft, merged: mergedDraft };
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, mergedDraft);
      return "deferred";
    }
    updateComposerDraftSettings(draftKey, {
      ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
      ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
      ...(queuedMessage.interactionMode ? { interactionMode: queuedMessage.interactionMode } : {}),
      ...(queuedMessage.creation
        ? {
            workspaceSelection: {
              mode: queuedMessage.creation.workspaceMode,
              branch: queuedMessage.creation.branch,
              worktreePath: queuedMessage.creation.worktreePath,
              pullRequestReference: queuedMessage.creation.pullRequestReference,
              ...(queuedMessage.creation.startFromOrigin !== undefined
                ? { startFromOrigin: queuedMessage.creation.startFromOrigin }
                : {}),
            },
          }
        : {}),
    });
    const restoredDraft = getComposerDraftSnapshot(draftKey);
    rollback = { snapshot: originalDraft, merged: restoredDraft };
    await flushComposerDrafts();
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    if (
      !(await removeThreadOutboxMessage(
        queuedMessage,
        revision,
        () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
      ))
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // After queue removal, the draft owns content and must never roll back.
    rollback = null;
    if (queuedMessage.creation) {
      withdrawError();
      recordPendingThreadCreationOutcome({
        kind: "failed",
        message: queuedMessage,
        reason: message,
      });
    }
    return "restored";
  } catch (error) {
    if (rollback !== null) {
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        (undoError) => {
          console.warn("[thread-outbox] failed to persist a recovery rollback", undoError);
        },
      );
    }
    console.warn("[thread-outbox] failed to restore an undeliverable message", error);
    setThreadComposerError(
      threadKey,
      error instanceof Error ? error.message : "The unsent message could not be restored.",
      queuedMessage.messageId,
    );
    return "retry";
  }
}

/** Derive keys from message ids so failed recovery retries reuse the same draft. */
function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? restoredNewTaskDraftKey(queuedMessage.messageId)
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
}

function stampRecoveryDraftProject(queuedMessage: QueuedThreadMessage, draftKey: string): void {
  if (!queuedMessage.creation) {
    return;
  }
  updateComposerDraftSettings(draftKey, {
    project: {
      environmentId: queuedMessage.environmentId,
      projectId: queuedMessage.creation.projectId,
      createdAt: queuedMessage.createdAt,
    },
  });
}

async function preserveUploadedAttachmentsForEditor(
  originalMessage: QueuedThreadMessage,
  uploadedMessage: QueuedThreadMessage,
): Promise<void> {
  if (!originalMessage.creation) {
    return;
  }

  const draftKey = `pending-task:${originalMessage.messageId}`;
  const draft = getComposerDraftSnapshot(draftKey);
  const uploadedById = new Map(
    uploadedMessage.attachments.map((attachment) => [attachment.id, attachment] as const),
  );
  let changed = false;
  const nextAttachments = draft.attachments.map((attachment) => {
    const uploaded = uploadedById.get(attachment.id);
    if (
      !uploaded?.uploadedAttachmentId ||
      uploaded.uploadEnvironmentId !== originalMessage.environmentId ||
      (attachment.uploadedAttachmentId === uploaded.uploadedAttachmentId &&
        attachment.uploadEnvironmentId === uploaded.uploadEnvironmentId)
    ) {
      return attachment;
    }
    changed = true;
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.uploadedAttachmentId,
      uploadEnvironmentId: uploaded.uploadEnvironmentId,
    };
  });
  if (changed) {
    replaceComposerDraftAttachments(draftKey, nextAttachments);
    await flushComposerDrafts();
  }
}

// Everything a drain pass decides from. Each queued environment's session is
// read here so a granted or revoked operate scope re-runs the drain.
const deliveryInputsAtom = Atom.make((get) => {
  const connectedEnvironments = get(workspaceConnections.environmentsAtom);
  const operableEnvironments = new Set<EnvironmentId>();
  for (const { environmentId } of connectedEnvironments) {
    if (
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      )
    ) {
      operableEnvironments.add(environmentId);
    }
  }
  return {
    dispatchingQueuedMessageId: get(dispatchingQueuedMessageIdAtom),
    editingQueuedMessageIds: get(editingQueuedMessageIdsAtom),
    queuedMessagesByThreadKey: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    shellStatuses: get(threadOutboxShellStatusesAtom),
    threads: get(environmentThreadShells.threadShellsAtom),
    projects: get(environmentProjects.projectsAtom),
    serverConfigs: get(environmentServerConfigsAtom),
    connectedEnvironments,
    operableEnvironments,
  };
}).pipe(Atom.withLabel("mobile:thread-outbox:delivery-inputs"));

// Read through the shell atom, not once: the shell often lands before the
// outcome is recorded, and that entry must still be collected when it does.
const settledCreationOutcomeKeysAtom = Atom.make((get): ReadonlyArray<string> => {
  const outcomes = get(pendingThreadCreationOutcomesAtom);
  const threads = get(environmentThreadShells.threadShellsAtom);
  return Object.entries(outcomes).flatMap(([threadKey, outcome]) =>
    outcome.kind === "delivered" &&
    threads.some(
      (thread) =>
        scopedThreadKey(thread.environmentId, thread.id) === threadKey &&
        (thread.latestRun !== null ||
          thread.runtime?.status === "failed" ||
          thread.runtime?.status === "cancelled" ||
          thread.runtime?.status === "interrupted"),
    )
      ? [threadKey]
      : [],
  );
}).pipe(Atom.withLabel("mobile:thread-outbox:settled-creation-outcomes"));

function deliveredSequence(
  result: AtomCommandResult<{ readonly sequence?: number }, unknown>,
): number | undefined {
  return AsyncResult.isSuccess(result) ? result.value.sequence : undefined;
}

const runDeliveryCommand = <W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Promise<AtomCommandResult<A, E>> =>
  runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });

function reportCommandFailure(
  queuedMessage: QueuedThreadMessage,
  commandResult: AtomCommandResult<unknown, unknown>,
  stage: ThreadOutboxCommandStage,
): { readonly action: "retry" | "restore"; readonly message: string } | null {
  if (!AsyncResult.isFailure(commandResult)) {
    return null;
  }
  const error = Cause.squash(commandResult.cause);
  const action = logThreadOutboxDeliveryFailure({
    stage,
    error,
    interrupted: Cause.hasInterruptsOnly(commandResult.cause),
    context: {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      cause: commandResult.cause,
    },
  });
  return {
    action,
    message: error instanceof Error ? error.message : "The message could not be sent.",
  };
}

interface ThreadOutboxRetry {
  readonly attempt: number;
  readonly notBefore: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Delivers queued thread messages one at a time. A drain pass runs whenever its inputs
 * change (outbox, locks, shells, projects, configs, connections, scopes) and when a retry
 * backoff expires. `dispatchingQueuedMessageIdAtom` is the single in-flight slot; clearing
 * it re-runs the drain for the next message.
 */
export function createThreadOutboxDelivery(): {
  readonly drain: () => void;
  readonly dispose: () => void;
} {
  let disposed = false;
  const retries = new Map<MessageId, ThreadOutboxRetry>();
  // Existing-thread turns the server accepted but whose outbox removal has
  // not landed; the next pass retries only the removal, never the send.
  const acknowledgedExistingThreadMessageIds = new Set<MessageId>();
  // Targets the shell may have left out hold their thread family until they leave the queue, so
  // the row stays readable through dispatch.
  const familyMounts = new Map<MessageId, () => void>();
  const blockedRecoveries = new Map<
    MessageId,
    { readonly message: QueuedThreadMessage; readonly unsubscribe: () => void }
  >();

  const retryNotBefore = (messageId: MessageId): number => retries.get(messageId)?.notBefore ?? 0;

  const scheduleRetry = (messageId: MessageId): void => {
    if (disposed) return;
    const previous = retries.get(messageId);
    if (previous !== undefined) clearTimeout(previous.timer);
    const attempt = (previous?.attempt ?? 0) + 1;
    const delayMs = threadOutboxRetryDelayMs(attempt);
    retries.set(messageId, {
      attempt,
      notBefore: Date.now() + delayMs,
      timer: setTimeout(drain, delayMs),
    });
  };

  const clearRetry = (messageId: MessageId): void => {
    const retry = retries.get(messageId);
    if (retry === undefined) return;
    clearTimeout(retry.timer);
    retries.delete(messageId);
  };

  // A delivery that throws backs off like any failure. Releasing the slot
  // without a retry would re-run the drain straight into the same message.
  const settle = (messageId: MessageId, delivery: Promise<boolean>): void => {
    void delivery
      .then(
        (sent) => (sent ? clearRetry(messageId) : scheduleRetry(messageId)),
        (error: unknown) => {
          console.warn("[thread-outbox] queued message delivery threw", { messageId, error });
          scheduleRetry(messageId);
        },
      )
      .finally(() => finishDispatchingQueuedMessage(messageId));
  };

  // An over-cap draft blocks recovery until the user changes its attachments;
  // parking on the draft avoids hammering the restore with backoff retries.
  const restoreQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    message: string,
  ): Promise<boolean> => {
    const result = await restoreRejectedQueuedMessage(queuedMessage, message);
    if (result !== "blocked") {
      return result !== "retry";
    }
    if (disposed || blockedRecoveries.has(queuedMessage.messageId)) {
      return true;
    }
    const draftKey = recoveryDraftKey(queuedMessage);
    const editorDraftKey = queuedMessage.creation
      ? `pending-task:${queuedMessage.messageId}`
      : null;
    const currentDrafts = appAtomRegistry.get(composerDraftsAtom);
    const blockedAttachments = currentDrafts[draftKey]?.attachments;
    const editorAttachments =
      editorDraftKey === null ? undefined : currentDrafts[editorDraftKey]?.attachments;
    const unsubscribe = appAtomRegistry.subscribe(composerDraftsAtom, (drafts) => {
      if (
        drafts[draftKey]?.attachments === blockedAttachments &&
        (editorDraftKey === null || drafts[editorDraftKey]?.attachments === editorAttachments)
      ) {
        return;
      }
      const active = blockedRecoveries.get(queuedMessage.messageId);
      if (!active) {
        return;
      }
      blockedRecoveries.delete(queuedMessage.messageId);
      active.unsubscribe();
      drain();
    });
    blockedRecoveries.set(queuedMessage.messageId, { message: queuedMessage, unsubscribe });
    return true;
  };

  const sendQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    thread: EnvironmentThreadShell,
  ): Promise<boolean> => {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return true;
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return false;
    const settings = resolveQueuedThreadSettings(queuedMessage, thread, serverConfig.providers);
    if (isModelSelectionUnavailable(serverConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    // The server would refuse this mode in settings sync, which retries forever; stop first.
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
    );
    if (runtimeModeDenial !== undefined) {
      return restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }

    if (settings.runtimeMode !== thread.runtimeMode) {
      if (!hasAccess()) return true;
      const runtimeResult = await runDeliveryCommand(threadEnvironment.setRuntimeMode, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "runtime-mode"),
          threadId: queuedMessage.threadId,
          runtimeMode: settings.runtimeMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(runtimeResult)) {
        reportCommandFailure(queuedMessage, runtimeResult, "settings-sync");
        return false;
      }
    }

    if (settings.interactionMode !== thread.interactionMode) {
      if (!hasAccess()) return true;
      const interactionResult = await runDeliveryCommand(threadEnvironment.setInteractionMode, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "interaction-mode"),
          threadId: queuedMessage.threadId,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(interactionResult)) {
        reportCommandFailure(queuedMessage, interactionResult, "settings-sync");
        return false;
      }
    }

    let prepared: PreparedTurnAttachments;
    let persistedMessage: QueuedThreadMessage;
    let deliveryRevision: number;
    if (!hasAccess()) return true;
    try {
      const preparedResult = await prepareQueuedMessageAttachments(queuedMessage);
      if (preparedResult.status === "abandoned") {
        return true;
      }
      prepared = preparedResult.prepared;
      persistedMessage = preparedResult.persistedMessage;
      deliveryRevision = preparedResult.deliveryRevision;
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        await preserveUploadedAttachmentsForEditor(queuedMessage, preparedResult.persistedMessage);
        return true;
      }
    } catch (error) {
      if (!hasAccess()) return true;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return restoreQueuedMessage(
          queuedMessage,
          error instanceof Error ? error.message : "An attachment could not upload.",
        );
      }
      return false;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return true;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return false;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (!hasAccess()) return true;
    const deliveryResult = await runDeliveryCommand(threadEnvironment.startTurn, {
      environmentId: queuedMessage.environmentId,
      input: {
        commandId: queuedMessage.commandId,
        creationSource: "mobile",
        threadId: queuedMessage.threadId,
        message: {
          messageId: queuedMessage.messageId,
          role: "user",
          ...serializeComposerMessageForServer(
            queuedMessage.text,
            uploadedComposerContext(
              queuedMessage.context,
              queuedMessage.attachments,
              prepared.attachments,
            ),
          ),
          attachments: prepared.attachments,
        },
        modelSelection: sendSettings.modelSelection,
        titleSeed: deriveThreadTitleSeed({
          text: queuedMessage.text,
          attachments: queuedMessage.attachments,
        }),
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt: queuedMessage.createdAt,
        dispatchMode: queuedMessage.dispatchMode ?? "start",
      },
    });
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return true;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return false;
    }
    if (failure?.action === "restore") {
      return restoreQueuedMessage(persistedMessage, failure.message);
    }
    acknowledgedExistingThreadMessageIds.add(persistedMessage.messageId);
    const delivered =
      (await completeQueuedMessageDelivery(
        persistedMessage,
        deliveryRevision,
        deliveredSequence(deliveryResult),
      )) === "removed";
    if (delivered) {
      acknowledgedExistingThreadMessageIds.delete(persistedMessage.messageId);
    }
    return delivered;
  };

  const sendQueuedCreation = async (
    queuedMessage: QueuedThreadMessage,
    creation: QueuedThreadCreation,
    projectCwd: string,
  ): Promise<boolean> => {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return true;
    const modelSelection = queuedMessage.modelSelection;
    if (modelSelection === undefined) {
      return false;
    }
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return false;
    const settings = resolveQueuedThreadSettings(
      queuedMessage,
      {
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      },
      serverConfig.providers,
    );
    if (isModelSelectionUnavailable(serverConfig, settings.modelSelection, creation.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        settings.modelSelection,
        creation.projectId,
      );
      return restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
    );
    if (runtimeModeDenial !== undefined) {
      return restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }
    let prepared: PreparedTurnAttachments;
    let persistedMessage: QueuedThreadMessage;
    let deliveryRevision: number;
    try {
      const preparedResult = await prepareQueuedMessageAttachments(queuedMessage);
      if (preparedResult.status === "abandoned") {
        return true;
      }
      prepared = preparedResult.prepared;
      persistedMessage = preparedResult.persistedMessage;
      deliveryRevision = preparedResult.deliveryRevision;
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        await preserveUploadedAttachmentsForEditor(queuedMessage, preparedResult.persistedMessage);
        return true;
      }
    } catch (error) {
      if (!hasAccess()) return true;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return restoreQueuedMessage(
          queuedMessage,
          error instanceof Error ? error.message : "An attachment could not upload.",
        );
      }
      return false;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return true;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return false;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, creation.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        creation.projectId,
      );
      return restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (!hasAccess()) return true;
    let workspace = creation;
    if (creation.pullRequestReference) {
      const checkout = await runDeliveryCommand(gitEnvironment.preparePullRequestThread, {
        environmentId: queuedMessage.environmentId,
        input: { cwd: projectCwd, reference: creation.pullRequestReference, mode: "worktree" },
      });
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision) || !hasAccess())
        return true;
      const failure = reportCommandFailure(queuedMessage, checkout, "start-turn");
      if (failure?.action === "retry") return false;
      if (failure?.action === "restore")
        return restoreQueuedMessage(persistedMessage, failure.message);
      if (!AsyncResult.isSuccess(checkout)) return false;
      if (!checkout.value.worktreePath || !checkout.value.isOnPullRequestHead) {
        const { shortLabel } = (
          sourceControlClients.findByChangeRequestUrl(creation.pullRequestReference) ??
          sourceControlClients.get(undefined)
        ).changeRequest;
        return restoreQueuedMessage(
          persistedMessage,
          `The ${shortLabel} worktree has local changes and could not update to the ${shortLabel} head. Resolve them before trying again.`,
        );
      }
      workspace = {
        ...creation,
        workspaceMode: "local",
        branch: checkout.value.branch,
        worktreePath: checkout.value.worktreePath,
        startFromOrigin: false,
      };
    }
    const deliveryResult = await runDeliveryCommand(threadEnvironment.startTurn, {
      environmentId: queuedMessage.environmentId,
      input: buildProjectThreadStartTurnInput({
        projectId: creation.projectId,
        projectCwd,
        threadId: queuedMessage.threadId,
        commandId: queuedMessage.commandId,
        messageId: queuedMessage.messageId,
        createdAt: queuedMessage.createdAt,
        titleText: queuedMessage.text,
        ...serializeComposerMessageForServer(
          queuedMessage.text.trim(),
          uploadedComposerContext(
            queuedMessage.context,
            queuedMessage.attachments,
            prepared.attachments,
          ),
        ),
        uploadedAttachments: prepared.attachments,
        modelSelection: sendSettings.modelSelection,
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        workspaceMode: workspace.workspaceMode,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        startFromOrigin: workspace.startFromOrigin ?? false,
        worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
      }),
    });
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return true;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return false;
    }
    if (failure?.action === "restore") {
      return restoreQueuedMessage(persistedMessage, failure.message);
    }
    recordPendingThreadCreationOutcome({ kind: "delivered", message: persistedMessage });
    const outcome = await completeQueuedMessageDelivery(
      persistedMessage,
      deliveryRevision,
      deliveredSequence(deliveryResult),
    );
    if (outcome === "edited") {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return true;
      }
      return recoverEditedCreationAfterDelivery(persistedMessage);
    }
    return outcome === "removed";
  };

  // A pass writes atoms the pass reads (family mounts, the dispatch slot), and the registry
  // notifies subscribers synchronously, so drain() can be called from inside a pass. That call
  // only asks for another pass; a nested pass would decide from inputs the outer one is still
  // acting on and could start a second delivery.
  let draining = false;
  let drainRequested = false;
  function drain(): void {
    if (disposed) return;
    if (draining) {
      drainRequested = true;
      return;
    }
    draining = true;
    try {
      do {
        if (disposed) return;
        drainRequested = false;
        drainPass();
      } while (drainRequested);
    } finally {
      draining = false;
    }
  }

  function drainPass(): void {
    const {
      dispatchingQueuedMessageId,
      editingQueuedMessageIds,
      queuedMessagesByThreadKey,
      shellStatuses,
      threads,
      projects,
      serverConfigs,
      connectedEnvironments,
      operableEnvironments,
    } = appAtomRegistry.get(deliveryInputsAtom);
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    const queuedMessageIds = new Set(
      Object.values(queuedMessagesByThreadKey)
        .flat()
        .map((message) => message.messageId),
    );
    for (const messageId of acknowledgedExistingThreadMessageIds) {
      if (!queuedMessageIds.has(messageId)) {
        acknowledgedExistingThreadMessageIds.delete(messageId);
      }
    }
    for (const [messageId, release] of familyMounts) {
      if (!queuedMessageIds.has(messageId)) {
        release();
        familyMounts.delete(messageId);
      }
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      const messageId = nextQueuedMessage.messageId;
      if (
        nextQueuedMessage.creation === undefined &&
        acknowledgedExistingThreadMessageIds.has(messageId)
      ) {
        if (retryNotBefore(messageId) > Date.now()) {
          continue;
        }
        beginDispatchingQueuedMessage(messageId);
        settle(
          messageId,
          removeAcknowledgedExistingThreadMessage(
            nextQueuedMessage,
            acknowledgedExistingThreadMessageIds,
          ),
        );
        return;
      }
      if (editingQueuedMessageIds[messageId]) {
        continue;
      }
      const blockedRecovery = blockedRecoveries.get(messageId);
      if (blockedRecovery) {
        if (blockedRecovery.message === nextQueuedMessage) {
          continue;
        }
        blockedRecoveries.delete(messageId);
        blockedRecovery.unsubscribe();
      }
      if (retryNotBefore(messageId) > Date.now()) {
        continue;
      }

      let thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const serverConfig = serverConfigs.get(nextQueuedMessage.environmentId);
      let familyRead: ThreadFamilyRead | undefined;
      if (
        thread === undefined &&
        creation === undefined &&
        serverConfig?.shellThreadFamilies === true
      ) {
        // The family keeps the row readable through dispatch once it loads; the current shell
        // generation's read decides whether the thread is gone.
        if (!familyMounts.has(nextQueuedMessage.messageId)) {
          familyMounts.set(
            nextQueuedMessage.messageId,
            threadFamilies.mount(
              appAtomRegistry,
              nextQueuedMessage.environmentId,
              nextQueuedMessage.threadId,
            ),
          );
        }
        familyRead = threadFamilyRead(
          appAtomRegistry.get(
            threadFamilies.familyAtom(nextQueuedMessage.environmentId, nextQueuedMessage.threadId),
          ),
        );
        if (familyRead === "settled") {
          // The rows read at the start of this pass can lag the family that just settled;
          // decide from the merged rows as they are now.
          thread = findThread(
            appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
        } else if (familyRead === "failed") {
          threadFamilies.refresh(
            appAtomRegistry,
            nextQueuedMessage.environmentId,
            nextQueuedMessage.threadId,
          );
        }
      }
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        ...(familyRead === undefined ? {} : { familyRead }),
      });
      if (
        deliveryAction === "wait" &&
        shellStatus === "live" &&
        familyRead !== undefined &&
        familyRead !== "settled"
      ) {
        // An empty family read changes no merged row, so nothing else would wake the drain.
        scheduleRetry(messageId);
        continue;
      }
      if (deliveryAction === "send" && !operableEnvironments.has(nextQueuedMessage.environmentId)) {
        continue;
      }
      const dispatchStep = resolveThreadOutboxDispatchStep({
        deliveryAction,
        fileAttachments: nextQueuedMessage.attachments.filter(
          (attachment) => attachment.type === "file",
        ),
        serverConfig: serverConfig
          ? {
              maxFileUploadBytes:
                serverConfig.environment.capabilities.fileAttachments?.maxUploadBytes,
            }
          : null,
      });
      if (dispatchStep.step === "wait") {
        continue;
      }
      if (dispatchStep.step === "retry") {
        scheduleRetry(messageId);
        continue;
      }
      if (dispatchStep.step === "restore") {
        const attachmentError = dispatchStep.reason;
        beginDispatchingQueuedMessage(messageId);
        settle(
          messageId,
          confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) =>
            !queued || appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId]
              ? true
              : restoreQueuedMessage(nextQueuedMessage, attachmentError),
          ),
        );
        return;
      }
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          continue;
        }
        if (creationProjectCwd === null && shellStatus !== "live") {
          continue;
        }
      }

      beginDispatchingQueuedMessage(messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId,
              error,
            });
            return false;
          },
        );
      // Confirm durability before sending; optimistic enqueue can still roll back on write failure.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          return true;
        }
        // Re-check editor ownership after confirmation; return true to defer without failure backoff.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId]) {
          return true;
        }
        if (deliveryAction === "send") {
          const liveThread = findThread(
            appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
          const liveDeliveryAction = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: liveThread !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
          });
          if (liveDeliveryAction !== "send") {
            return true;
          }
        }
        return deliveryAction === "remove"
          ? creation !== undefined
            ? // After restart, always recover delivered creations; lost in-memory state cannot distinguish edits from duplicate payloads.
              recoverEditedCreationAfterDelivery(nextQueuedMessage)
            : removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
            : thread !== undefined
              ? sendQueuedMessage(nextQueuedMessage, thread)
              : Promise.resolve(false);
      });
      settle(messageId, delivery);
      return;
    }
  }

  const stopDraining = appAtomRegistry.subscribe(deliveryInputsAtom, drain, { immediate: true });
  const stopCollectingOutcomes = appAtomRegistry.subscribe(
    settledCreationOutcomeKeysAtom,
    (threadKeys) => {
      for (const threadKey of threadKeys) clearPendingThreadCreationOutcome(threadKey);
    },
    { immediate: true },
  );

  return {
    drain,
    dispose: () => {
      disposed = true;
      stopDraining();
      stopCollectingOutcomes();
      for (const retry of retries.values()) clearTimeout(retry.timer);
      retries.clear();
      for (const blocked of blockedRecoveries.values()) blocked.unsubscribe();
      blockedRecoveries.clear();
      for (const release of familyMounts.values()) release();
      familyMounts.clear();
    },
  };
}

function loadThreadOutbox(isActive: () => boolean): void {
  void threadOutboxManager.load().then((loaded) => {
    if (loaded || !isActive()) return;
    Dialog.alert(
      "Some queued messages could not be loaded",
      "Unreadable records and attachment files are still saved. Other messages can still be sent.",
      [
        { text: "Dismiss", style: "cancel" },
        { text: "Retry", onPress: () => loadThreadOutbox(isActive) },
      ],
    );
  });
}

/** App-lifetime: loads the persisted outbox and delivers queued messages. */
export function installThreadOutboxDelivery(): () => void {
  let active = true;
  loadThreadOutbox(() => active);
  const delivery = createThreadOutboxDelivery();
  return () => {
    active = false;
    delivery.dispose();
  };
}
