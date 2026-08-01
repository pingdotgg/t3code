import { RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { scopedProjectKey, scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment } from "./threads";
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
import { editingQueuedMessageIdsAtom, threadOutboxShellStatusesAtom } from "./use-thread-outbox";
import { setPendingConnectionError } from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

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

/**
 * Uploads a queued message's attachments and persists the uploaded ids back
 * onto the queued message. The revision-checked update means an edit accepted
 * while the bytes uploaded wins: this attempt abandons and the next drain pass
 * re-reads the message.
 * `deliveryRevision` is the revision of the payload this attempt will send,
 * used for the delivery removal's compare-and-set.
 */
export async function prepareQueuedMessageAttachments(
  queuedMessage: QueuedThreadMessage,
  supportsImageUploads = false,
): Promise<
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
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "abandoned" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const result = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads,
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

/**
 * Removes a delivered message from the outbox. The revision and editor checks
 * preserve a creation payload when its pending-task editor owns newer work.
 * The outcome tells the caller whether removal completed, ownership changed,
 * or storage cleanup failed. Exported for tests.
 */
export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
): Promise<"removed" | "edited" | "failed"> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    // The editor may have taken the entry while startTurn was in flight; its
    // unsaved edits have not bumped the revision yet, so the CAS alone would
    // let removal win and the editor would lose them once it saves.
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    // Removal also releases the message's local attachment files.
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    if (!removed) {
      console.warn(
        "[thread-outbox] delivered message was edited before cleanup; keeping the newer message",
        {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
        },
      );
      return "edited";
    }
    return "removed";
  } catch (error) {
    console.warn("[thread-outbox] failed to remove delivered queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return "failed";
  }
}

/** Retries local cleanup for an existing-thread send acknowledged in this drain lifetime. */
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

/**
 * A creation delivered its startTurn but an edit won the cleanup race, so the
 * edited payload is still queued. The next drain would see the created thread
 * and take the creation "remove" path, silently discarding the edit; hand the
 * edited content to the new thread's composer instead and remove the entry.
 * Returns true when recovery is complete or an open editor owns the next
 * action, and false when the drain should retry with backoff.
 * Exported for tests; the drain is the only production caller.
 */
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
    // Merge before removing: the draft's reference keeps the removal sweep
    // from deleting the attachment files. allowOverflow mirrors the
    // send-failure restore; the send path refuses over-cap drafts, so the
    // state stays recoverable.
    await mergeComposerDraftContent(draftKey, { text: kept.text, attachments: [] });
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
    // Only settings the queued message actually carries: spreading explicit
    // undefined would clear choices the user already made on the draft.
    updateComposerDraftSettings(draftKey, {
      ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
      ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
      ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
    });
    // The append only schedules a debounced write; the queue entry is the
    // only durable copy until the draft lands, so flush before removing.
    await flushComposerDrafts();
  } catch (error) {
    // Keep the entry queued. The drain retries with backoff, and the merge is
    // idempotent so content that persisted before the failure is not repeated.
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

/** Exported for tests; the drain is the only production caller. */
export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "deferred" | "blocked" | "retry"> {
  const draftKey = recoveryDraftKey(queuedMessage);
  // Set once the merge publishes, cleared once the queued message is removed.
  // The catch below uses it to take the merged content back out, so a retry
  // after a mid-recovery failure cannot append the recovered text again.
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      return "deferred";
    }
    // The confirmation above checked this exact payload is what is queued, so
    // the current revision guards the removal at the end against an edit
    // accepted while this recovery ran.
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
      setPendingConnectionError(
        `Remove attachments from the draft before restoring this message. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
      return "blocked";
    }

    let mergedDraft: ComposerDraft;
    try {
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
      });
    } finally {
      // Snapshots for the rollbacks below: undoComposerDraftMerge restores
      // the original draft only while it is untouched, and otherwise takes
      // out just what this recovery inserted so edits typed during the awaits
      // survive. Captured in a finally because mergeComposerDraftContent
      // publishes before its persistence await: even its failure leaves the
      // merged content in the draft.
      mergedDraft = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot: originalDraft, merged: mergedDraft };
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
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
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // Revision-checked: an edit that landed after the confirmation above
    // must not be deleted with the pre-edit payload this recovery restored.
    if (
      !(await removeThreadOutboxMessage(
        queuedMessage,
        revision,
        () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
      ))
    ) {
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // The queued message is gone; from here the draft owns the content and
    // must never be rolled back.
    rollback = null;
    setPendingConnectionError(message);
    return "restored";
  } catch (error) {
    if (rollback !== null) {
      // Take the recovered content back out (keeping edits typed since) so
      // the retry's merge starts clean instead of appending a duplicate. The
      // in-memory rollback lands even when its own persistence write fails.
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        (undoError) => {
          console.warn("[thread-outbox] failed to persist a recovery rollback", undoError);
        },
      );
    }
    console.warn("[thread-outbox] failed to restore an undeliverable message", error);
    setPendingConnectionError(
      error instanceof Error ? error.message : "The unsent message could not be restored.",
    );
    return "retry";
  }
}

function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? `new-task:${scopedProjectKey(queuedMessage.environmentId, queuedMessage.creation.projectId)}`
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
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

interface BlockedRecoverySubscription {
  readonly message: QueuedThreadMessage;
  readonly unsubscribe: () => void;
}

interface ThreadOutboxDrainState {
  readonly registry: AtomRegistry.AtomRegistry;
  owners: number;
  stopped: boolean;
  drainScheduled: boolean;
  activeDelivery: Promise<void> | null;
  readonly retryAttempt: Map<MessageId, number>;
  readonly retryNotBefore: Map<MessageId, number>;
  readonly retryTimers: Map<MessageId, ReturnType<typeof setTimeout>>;
  /**
   * Existing-thread sends whose startTurn was acknowledged but whose local
   * removal has not completed. Kept across owner changes so a later owner
   * retries only the cleanup instead of re-sending the delivered turn.
   */
  readonly acknowledgedExistingThreadMessageIds: Set<MessageId>;
  readonly blockedRecoverySubscriptions: Map<MessageId, BlockedRecoverySubscription>;
  readonly releases: Array<() => void>;
}

const drainStates = new WeakMap<AtomRegistry.AtomRegistry, ThreadOutboxDrainState>();

function requestDrain(state: ThreadOutboxDrainState): void {
  if (state.stopped || state.drainScheduled) {
    return;
  }
  state.drainScheduled = true;
  queueMicrotask(() => {
    state.drainScheduled = false;
    drainOnce(state);
  });
}

function clearRetry(state: ThreadOutboxDrainState, messageId: MessageId): void {
  state.retryAttempt.delete(messageId);
  state.retryNotBefore.delete(messageId);
  const timer = state.retryTimers.get(messageId);
  if (timer !== undefined) {
    clearTimeout(timer);
    state.retryTimers.delete(messageId);
  }
}

function scheduleRetry(state: ThreadOutboxDrainState, messageId: MessageId): void {
  // An in-flight delivery can settle after the final owner releases. Do not
  // recreate timers that stopDrain already cleared while nobody owns the
  // dispatcher; a later owner will perform a fresh drain immediately.
  if (state.stopped) {
    return;
  }
  const retryAttempt = (state.retryAttempt.get(messageId) ?? 0) + 1;
  state.retryAttempt.set(messageId, retryAttempt);
  const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
  state.retryNotBefore.set(messageId, Date.now() + retryDelayMs);
  const pendingTimer = state.retryTimers.get(messageId);
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
  }
  const timer = setTimeout(() => {
    state.retryTimers.delete(messageId);
    requestDrain(state);
  }, retryDelayMs);
  state.retryTimers.set(messageId, timer);
}

function releaseBlockedRecovery(state: ThreadOutboxDrainState, messageId: MessageId): void {
  const blocked = state.blockedRecoverySubscriptions.get(messageId);
  if (!blocked) {
    return;
  }
  state.blockedRecoverySubscriptions.delete(messageId);
  blocked.unsubscribe();
}

function supportsImageUploads(
  state: ThreadOutboxDrainState,
  queuedMessage: QueuedThreadMessage,
): boolean {
  return (
    state.registry.get(environmentServerConfigsAtom).get(queuedMessage.environmentId)?.environment
      .capabilities.attachmentUploads === true
  );
}

/**
 * Runs one dispatch for `messageId`. The dispatching atom and `activeDelivery`
 * keep every owner off the queue until the work settles, after which the next
 * drain pass is requested.
 */
function dispatch(
  state: ThreadOutboxDrainState,
  messageId: MessageId,
  work: () => Promise<void>,
): void {
  state.registry.set(dispatchingQueuedMessageIdAtom, messageId);
  const completion = work()
    .catch((error) => {
      console.warn("[thread-outbox] queued message drain failed", { messageId, error });
      scheduleRetry(state, messageId);
    })
    .finally(() => {
      if (state.registry.get(dispatchingQueuedMessageIdAtom) === messageId) {
        state.registry.set(dispatchingQueuedMessageIdAtom, null);
      }
      state.activeDelivery = null;
      requestDrain(state);
    });
  state.activeDelivery = completion;
}

function makeDeliveryHelpers(queuedMessage: QueuedThreadMessage) {
  const reportFailure = (
    commandResult: AtomCommandResult<unknown, unknown>,
    stage: ThreadOutboxCommandStage,
  ): { readonly action: "retry" | "restore"; readonly message: string } | null => {
    if (!AsyncResult.isFailure(commandResult)) {
      return null;
    }
    const error = Cause.squash(commandResult.cause);
    const action = resolveThreadOutboxFailureAction({
      stage,
      error,
      interrupted: Cause.hasInterruptsOnly(commandResult.cause),
    });
    console.warn("[thread-outbox] queued message delivery failed", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      stage,
      cause: commandResult.cause,
      action,
    });
    return {
      action,
      message: error instanceof Error ? error.message : "The message could not be sent.",
    };
  };
  return { reportFailure };
}

async function restoreQueuedMessage(
  state: ThreadOutboxDrainState,
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<boolean> {
  const result = await restoreRejectedQueuedMessage(queuedMessage, message);
  if (result !== "blocked") {
    return result !== "retry";
  }
  if (state.stopped || state.blockedRecoverySubscriptions.has(queuedMessage.messageId)) {
    return true;
  }

  const draftKey = recoveryDraftKey(queuedMessage);
  const editorDraftKey = queuedMessage.creation ? `pending-task:${queuedMessage.messageId}` : null;
  const currentDrafts = state.registry.get(composerDraftsAtom);
  const blockedAttachments = currentDrafts[draftKey]?.attachments;
  const editorAttachments =
    editorDraftKey === null ? undefined : currentDrafts[editorDraftKey]?.attachments;
  const unsubscribe = state.registry.subscribe(composerDraftsAtom, (drafts) => {
    if (
      drafts[draftKey]?.attachments === blockedAttachments &&
      (editorDraftKey === null || drafts[editorDraftKey]?.attachments === editorAttachments)
    ) {
      return;
    }
    if (!state.blockedRecoverySubscriptions.has(queuedMessage.messageId)) {
      return;
    }
    releaseBlockedRecovery(state, queuedMessage.messageId);
    requestDrain(state);
  });
  state.blockedRecoverySubscriptions.set(queuedMessage.messageId, {
    message: queuedMessage,
    unsubscribe,
  });
  return true;
}

async function sendQueuedMessage(
  state: ThreadOutboxDrainState,
  queuedMessage: QueuedThreadMessage,
  thread: EnvironmentThreadShell,
): Promise<boolean> {
  const settings = resolveQueuedThreadSettings(queuedMessage, thread);
  const { reportFailure } = makeDeliveryHelpers(queuedMessage);

  if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
    const updateResult = await runAtomCommand(
      state.registry,
      threadEnvironment.updateMetadata,
      {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "model-selection"),
          threadId: queuedMessage.threadId,
          modelSelection: settings.modelSelection,
        },
      },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(updateResult)) {
      reportFailure(updateResult, "settings-sync");
      return false;
    }
  }

  if (settings.runtimeMode !== thread.runtimeMode) {
    const runtimeResult = await runAtomCommand(
      state.registry,
      threadEnvironment.setRuntimeMode,
      {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "runtime-mode"),
          threadId: queuedMessage.threadId,
          runtimeMode: settings.runtimeMode,
          createdAt: queuedMessage.createdAt,
        },
      },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(runtimeResult)) {
      reportFailure(runtimeResult, "settings-sync");
      return false;
    }
  }

  if (settings.interactionMode !== thread.interactionMode) {
    const interactionResult = await runAtomCommand(
      state.registry,
      threadEnvironment.setInteractionMode,
      {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "interaction-mode"),
          threadId: queuedMessage.threadId,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      },
      { reportFailure: false },
    );
    if (AsyncResult.isFailure(interactionResult)) {
      reportFailure(interactionResult, "settings-sync");
      return false;
    }
  }

  let prepared: PreparedTurnAttachments;
  let persistedMessage: QueuedThreadMessage;
  let deliveryRevision: number;
  try {
    const preparedResult = await prepareQueuedMessageAttachments(
      queuedMessage,
      supportsImageUploads(state, queuedMessage),
    );
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
    console.warn("[thread-outbox] failed to upload attachments", error);
    if (!shouldRetryThreadOutboxDelivery(error)) {
      return restoreQueuedMessage(
        state,
        queuedMessage,
        error instanceof Error ? error.message : "An attachment could not upload.",
      );
    }
    return false;
  }
  if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
    return true;
  }
  const deliveryResult = await runAtomCommand(
    state.registry,
    threadEnvironment.startTurn,
    {
      environmentId: queuedMessage.environmentId,
      input: {
        commandId: queuedMessage.commandId,
        threadId: queuedMessage.threadId,
        message: {
          messageId: queuedMessage.messageId,
          role: "user",
          text: queuedMessage.text,
          attachments: prepared.attachments,
        },
        modelSelection: settings.modelSelection,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        createdAt: queuedMessage.createdAt,
      },
    },
    { reportFailure: false },
  );
  const failure = reportFailure(deliveryResult, "start-turn");
  if (failure?.action === "retry") {
    return false;
  }
  if (failure?.action === "restore") {
    return restoreQueuedMessage(state, persistedMessage, failure.message);
  }
  state.acknowledgedExistingThreadMessageIds.add(persistedMessage.messageId);
  const delivered =
    (await completeQueuedMessageDelivery(persistedMessage, deliveryRevision)) === "removed";
  if (delivered) {
    state.acknowledgedExistingThreadMessageIds.delete(persistedMessage.messageId);
    // The delivered turn holds its own copy of the bytes. A failed delete
    // is surfaced (never fails the delivered turn); the server also
    // expires leaked pending uploads.
    await prepared.releaseUploads().catch((error) => {
      console.warn("[thread-outbox] could not delete consumed pending uploads", error);
    });
  }
  return delivered;
}

async function sendQueuedCreation(
  state: ThreadOutboxDrainState,
  queuedMessage: QueuedThreadMessage,
  creation: QueuedThreadCreation,
  projectCwd: string,
): Promise<boolean> {
  const modelSelection = queuedMessage.modelSelection;
  if (modelSelection === undefined) {
    return false;
  }
  let prepared: PreparedTurnAttachments;
  let persistedMessage: QueuedThreadMessage;
  let deliveryRevision: number;
  try {
    const preparedResult = await prepareQueuedMessageAttachments(
      queuedMessage,
      supportsImageUploads(state, queuedMessage),
    );
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
    console.warn("[thread-outbox] failed to upload attachments", error);
    if (!shouldRetryThreadOutboxDelivery(error)) {
      return restoreQueuedMessage(
        state,
        queuedMessage,
        error instanceof Error ? error.message : "An attachment could not upload.",
      );
    }
    return false;
  }
  if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
    return true;
  }
  const deliveryResult = await runAtomCommand(
    state.registry,
    threadEnvironment.startTurn,
    {
      environmentId: queuedMessage.environmentId,
      input: buildProjectThreadStartTurnInput({
        projectId: creation.projectId,
        projectCwd,
        threadId: queuedMessage.threadId,
        commandId: queuedMessage.commandId,
        messageId: queuedMessage.messageId,
        createdAt: queuedMessage.createdAt,
        text: queuedMessage.text.trim(),
        attachments: queuedMessage.attachments,
        uploadedAttachments: prepared.attachments,
        modelSelection,
        runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceMode: creation.workspaceMode,
        branch: creation.branch,
        worktreePath: creation.worktreePath,
        startFromOrigin: creation.startFromOrigin ?? false,
        worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
      }),
    },
    { reportFailure: false },
  );
  const { reportFailure } = makeDeliveryHelpers(queuedMessage);
  const failure = reportFailure(deliveryResult, "start-turn");
  if (failure?.action === "retry") {
    return false;
  }
  if (failure?.action === "restore") {
    return restoreQueuedMessage(state, persistedMessage, failure.message);
  }
  const outcome = await completeQueuedMessageDelivery(persistedMessage, deliveryRevision);
  if (outcome === "edited") {
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      // The editor holds the entry with unsaved edits; merging the queue
      // payload now would duplicate the delivered turn. Once the editor
      // saves, the duplicate-creation removal below recovers the edits.
      return true;
    }
    // The thread exists now, so the next drain would remove the edited
    // payload as a duplicate creation. Hand it to the thread's composer.
    return recoverEditedCreationAfterDelivery(persistedMessage);
  }
  if (outcome === "removed") {
    await prepared.releaseUploads().catch((error) => {
      console.warn("[thread-outbox] could not delete consumed pending uploads", error);
    });
    return true;
  }
  return false;
}

function drainOnce(state: ThreadOutboxDrainState): void {
  if (
    state.stopped ||
    state.activeDelivery !== null ||
    state.registry.get(dispatchingQueuedMessageIdAtom) !== null
  ) {
    return;
  }

  const registry = state.registry;
  const queuedMessagesByThreadKey = registry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  const editingQueuedMessageIds = registry.get(editingQueuedMessageIdsAtom);
  const shellStatuses = registry.get(threadOutboxShellStatusesAtom);
  const threads = registry.get(environmentThreadShells.threadShellsAtom);
  const projects = registry.get(environmentProjects.projectsAtom);
  const serverConfigs = registry.get(environmentServerConfigsAtom);
  const presentations = registry.get(environmentPresentations.presentationsAtom);

  const queuedMessageIds = new Set(
    Object.values(queuedMessagesByThreadKey)
      .flat()
      .map((message) => message.messageId),
  );
  for (const messageId of state.acknowledgedExistingThreadMessageIds) {
    if (!queuedMessageIds.has(messageId)) {
      state.acknowledgedExistingThreadMessageIds.delete(messageId);
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
      state.acknowledgedExistingThreadMessageIds.has(messageId)
    ) {
      if ((state.retryNotBefore.get(messageId) ?? 0) > Date.now()) {
        continue;
      }
      dispatch(state, messageId, async () => {
        const removed = await removeAcknowledgedExistingThreadMessage(
          nextQueuedMessage,
          state.acknowledgedExistingThreadMessageIds,
        );
        if (removed) {
          clearRetry(state, messageId);
        } else {
          scheduleRetry(state, messageId);
        }
      });
      return;
    }
    if (editingQueuedMessageIds[messageId]) {
      continue;
    }
    const blockedRecovery = state.blockedRecoverySubscriptions.get(messageId);
    if (blockedRecovery) {
      if (blockedRecovery.message === nextQueuedMessage) {
        continue;
      }
      releaseBlockedRecovery(state, messageId);
    }
    if ((state.retryNotBefore.get(messageId) ?? 0) > Date.now()) {
      continue;
    }

    const thread = findThread(threads, nextQueuedMessage);
    if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
      continue;
    }

    const creation = nextQueuedMessage.creation;
    const environmentConnected =
      presentations.get(nextQueuedMessage.environmentId)?.connection.phase === "connected";
    const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
    const deliveryAction = resolveThreadOutboxDeliveryAction({
      isCreation: creation !== undefined,
      threadExists: thread !== undefined,
      shellStatus,
      environmentConnected,
      threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
    });
    // The delivery action resolves first; the file-capability gate applies
    // only to a message that will send. Gating earlier would restore a
    // creation whose startTurn already made the thread as a duplicate draft
    // instead of removing it.
    const serverConfig = serverConfigs.get(nextQueuedMessage.environmentId);
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
      // The environment is connected but its config has not synced yet.
      // Back off and retry instead of parking the message forever.
      scheduleRetry(state, messageId);
      continue;
    }
    if (dispatchStep.step === "restore") {
      const attachmentError = dispatchStep.reason;
      dispatch(state, messageId, async () => {
        const queued = await confirmThreadOutboxMessageQueued(nextQueuedMessage);
        const restored =
          !queued || registry.get(editingQueuedMessageIdsAtom)[messageId]
            ? true
            : await restoreQueuedMessage(state, nextQueuedMessage, attachmentError);
        if (!restored) {
          scheduleRetry(state, messageId);
        }
      });
      return;
    }
    // The live project shell is preferred for the workspace path, with the
    // snapshot taken at enqueue time as the fallback so a task never dies
    // just because its project shell is not loaded.
    const creationProjectCwd =
      creation !== undefined
        ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
          creation.projectCwd ??
          null)
        : null;
    // An incomplete pending task (e.g. worktree mode without a branch) stays
    // queued until the user finishes it in the editor.
    if (deliveryAction === "send" && creation !== undefined) {
      if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
        continue;
      }
      if (creationProjectCwd === null && shellStatus !== "live") {
        continue;
      }
    }

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
    dispatch(state, messageId, async () => {
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const queued = await confirmThreadOutboxMessageQueued(nextQueuedMessage);
      let sent: boolean;
      if (!queued) {
        // Rolled back by a failed write; nothing to deliver or retry.
        sent = true;
      } else if (registry.get(editingQueuedMessageIdsAtom)[messageId]) {
        // The guards evaluated before the confirmation await are stale by now:
        // the user may have opened this message in the editor. Defer to the
        // next drain pass rather than sending a payload being edited.
        sent = true;
      } else {
        // The shell state is equally stale. Re-run the same delivery policy
        // against the live thread snapshot so a vanished thread or newly
        // created target defers, while busy existing threads can still steer.
        let liveDeliveryAction = deliveryAction;
        if (deliveryAction === "send") {
          const liveThread = findThread(
            registry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
          liveDeliveryAction = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: liveThread !== undefined,
            shellStatus,
            environmentConnected,
            threadBusy:
              liveThread?.session?.status === "running" ||
              liveThread?.session?.status === "starting",
          });
        }
        if (deliveryAction === "send" && liveDeliveryAction !== "send") {
          sent = true;
        } else if (deliveryAction === "remove") {
          sent =
            creation !== undefined
              ? // A creation entry that survived its delivery cleanup either
                // holds edits (recover them) or the delivered payload (a
                // recovered duplicate the user can delete). Restart loses any
                // in-memory distinction, and losing edits is the worse failure,
                // so recovery is unconditional here.
                await recoverEditedCreationAfterDelivery(nextQueuedMessage)
              : await removeQueuedMessage(
                  "[thread-outbox] failed to remove message for a missing thread",
                );
        } else if (creation !== undefined) {
          sent =
            creationProjectCwd !== null
              ? await sendQueuedCreation(state, nextQueuedMessage, creation, creationProjectCwd)
              : await removeQueuedMessage(
                  "[thread-outbox] dropped pending task for a missing project",
                );
        } else {
          sent =
            thread !== undefined
              ? await sendQueuedMessage(state, nextQueuedMessage, thread)
              : false;
        }
      }
      if (sent) {
        clearRetry(state, messageId);
      } else {
        scheduleRetry(state, messageId);
      }
    });
    return;
  }
}

function startDrain(state: ThreadOutboxDrainState): void {
  if (!state.stopped) {
    return;
  }
  state.stopped = false;
  try {
    ensureThreadOutboxLoaded();
    const request = () => requestDrain(state);
    // Store each release as it is acquired so a later subscription failure can
    // still unwind every subscription that was already installed.
    state.releases.push(
      state.registry.subscribe(threadOutboxManager.queuedMessagesByThreadKeyAtom, request),
    );
    state.releases.push(state.registry.subscribe(editingQueuedMessageIdsAtom, request));
    state.releases.push(state.registry.subscribe(threadOutboxShellStatusesAtom, request));
    state.releases.push(
      state.registry.subscribe(environmentThreadShells.threadShellsAtom, request),
    );
    state.releases.push(state.registry.subscribe(environmentProjects.projectsAtom, request));
    state.releases.push(state.registry.subscribe(environmentServerConfigsAtom, request));
    state.releases.push(
      state.registry.subscribe(environmentPresentations.presentationsAtom, request),
    );
    state.releases.push(state.registry.subscribe(dispatchingQueuedMessageIdAtom, request));
    requestDrain(state);
  } catch (error) {
    stopDrain(state);
    throw error;
  }
}

function stopDrain(state: ThreadOutboxDrainState): void {
  if (state.stopped) {
    return;
  }
  state.stopped = true;
  for (const release of state.releases.splice(0)) {
    try {
      release();
    } catch (error) {
      console.warn("[thread-outbox] failed to release drain subscription", error);
    }
  }
  for (const timer of state.retryTimers.values()) {
    clearTimeout(timer);
  }
  state.retryTimers.clear();
  state.retryAttempt.clear();
  state.retryNotBefore.clear();
  for (const blocked of state.blockedRecoverySubscriptions.values()) {
    try {
      blocked.unsubscribe();
    } catch (error) {
      console.warn("[thread-outbox] failed to release blocked recovery subscription", error);
    }
  }
  state.blockedRecoverySubscriptions.clear();
}

/**
 * Acquires the one process-wide outbox dispatcher for a registry. UI and
 * Headless JS owners share this lease, so mounting both cannot double-send.
 */
export function acquireThreadOutboxDrain(registry: AtomRegistry.AtomRegistry): () => void {
  let state = drainStates.get(registry);
  if (state === undefined) {
    state = {
      registry,
      owners: 0,
      stopped: true,
      drainScheduled: false,
      activeDelivery: null,
      retryAttempt: new Map(),
      retryNotBefore: new Map(),
      retryTimers: new Map(),
      acknowledgedExistingThreadMessageIds: new Set(),
      blockedRecoverySubscriptions: new Map(),
      releases: [],
    };
    drainStates.set(registry, state);
  }
  state.owners += 1;
  try {
    startDrain(state);
  } catch (error) {
    state.owners -= 1;
    if (state.owners === 0) {
      drainStates.delete(registry);
    }
    throw error;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.owners -= 1;
    if (state.owners === 0) {
      stopDrain(state);
    }
  };
}

export function useThreadOutboxDrain(): void {
  const registry = useContext(RegistryContext);
  useEffect(() => acquireThreadOutboxDrain(registry), [registry]);
}
