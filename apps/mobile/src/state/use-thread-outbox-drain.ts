import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { randomHex } from "../lib/uuid";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useServerConfigs, useThreadShells } from "./entities";
import { serverEnvironment } from "./server";
import {
  confirmThreadOutboxMessageQueued,
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
  newTaskDraftKey,
  replaceComposerDraftAttachments,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import { useAtomCommand } from "./use-atom-command";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "./use-remote-environment-registry";

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
      stampRecoveryDraftProject(queuedMessage, draftKey);
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

/**
 * A rejected creation becomes its own new-task draft rather than merging into
 * whatever the user is typing for that project. The key derives from the
 * message id so a retry after a mid-recovery failure lands on the same draft
 * instead of minting another.
 */
function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? newTaskDraftKey(`restored-${queuedMessage.messageId}`)
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

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());
  const acknowledgedExistingThreadMessageIdsRef = useRef(new Set<MessageId>());
  const blockedRecoverySubscriptionsRef = useRef(
    new Map<
      MessageId,
      { readonly message: QueuedThreadMessage; readonly unsubscribe: () => void }
    >(),
  );

  const scheduleQueuedMessageRetry = useCallback((messageId: MessageId) => {
    const retryAttempt = (retryAttemptRef.current.get(messageId) ?? 0) + 1;
    retryAttemptRef.current.set(messageId, retryAttempt);
    const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
    retryNotBeforeRef.current.set(messageId, Date.now() + retryDelayMs);
    const pendingTimer = retryTimersRef.current.get(messageId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
    }
    const retryTimer = setTimeout(() => {
      retryTimersRef.current.delete(messageId);
      setRetryTick((current) => current + 1);
    }, retryDelayMs);
    retryTimersRef.current.set(messageId, retryTimer);
  }, []);

  const restoreQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, message: string): Promise<boolean> => {
      const result = await restoreRejectedQueuedMessage(queuedMessage, message);
      if (result !== "blocked") {
        return result !== "retry";
      }

      if (!blockedRecoverySubscriptionsRef.current.has(queuedMessage.messageId)) {
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
          const active = blockedRecoverySubscriptionsRef.current.get(queuedMessage.messageId);
          if (!active) {
            return;
          }
          blockedRecoverySubscriptionsRef.current.delete(queuedMessage.messageId);
          active.unsubscribe();
          setRetryTick((current) => current + 1);
        });
        blockedRecoverySubscriptionsRef.current.set(queuedMessage.messageId, {
          message: queuedMessage,
          unsubscribe,
        });
      }
      return true;
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if ((await threadOutboxManager.load()) || !mounted) return;
      Alert.alert(
        "Some queued messages could not be loaded",
        "Unreadable records and attachment files are still saved. Other messages can still be sent.",
        [
          { text: "Dismiss", style: "cancel" },
          { text: "Retry", onPress: () => void load() },
        ],
      );
    };
    void load();
    return () => {
      mounted = false;
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
      for (const blocked of blockedRecoverySubscriptionsRef.current.values()) {
        blocked.unsubscribe();
      }
      blockedRecoverySubscriptionsRef.current.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
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
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const serverConfig = appAtomRegistry.get(
        serverEnvironment.configValueAtom(queuedMessage.environmentId),
      );
      if (!serverConfig) return false;
      const settings = resolveQueuedThreadSettings(queuedMessage, thread, serverConfig.providers);
      if (isModelSelectionUnavailable(serverConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          queuedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const { reportFailure } = makeDeliveryHelpers(queuedMessage);

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          reportFailure(updateResult, "settings-sync");
          return false;
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          reportFailure(runtimeResult, "settings-sync");
          return false;
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: queuedMessage.createdAt,
          },
        });
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
          serverConfig.environment.capabilities.attachmentUploads === true,
        );
        if (preparedResult.status === "abandoned") {
          return true;
        }
        prepared = preparedResult.prepared;
        persistedMessage = preparedResult.persistedMessage;
        deliveryRevision = preparedResult.deliveryRevision;
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
          await preserveUploadedAttachmentsForEditor(
            queuedMessage,
            preparedResult.persistedMessage,
          );
          return true;
        }
      } catch (error) {
        console.warn("[thread-outbox] failed to upload attachments", error);
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
      if (isModelSelectionUnavailable(currentConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          persistedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const sendSettings = resolveQueuedThreadSettings(
        queuedMessage,
        settings,
        currentConfig.providers,
      );
      const deliveryResult = await startTurn({
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
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      const failure = reportFailure(deliveryResult, "start-turn");
      if (failure?.action === "retry") {
        return false;
      }
      if (failure?.action === "restore") {
        return restoreQueuedMessage(persistedMessage, failure.message);
      }
      acknowledgedExistingThreadMessageIdsRef.current.add(persistedMessage.messageId);
      const delivered =
        (await completeQueuedMessageDelivery(persistedMessage, deliveryRevision)) === "removed";
      if (delivered) {
        acknowledgedExistingThreadMessageIdsRef.current.delete(persistedMessage.messageId);
      }
      return delivered;
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
      restoreQueuedMessage,
    ],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) => {
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
      if (isModelSelectionUnavailable(serverConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          queuedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      let prepared: PreparedTurnAttachments;
      let persistedMessage: QueuedThreadMessage;
      let deliveryRevision: number;
      try {
        const preparedResult = await prepareQueuedMessageAttachments(
          queuedMessage,
          serverConfig.environment.capabilities.attachmentUploads === true,
        );
        if (preparedResult.status === "abandoned") {
          return true;
        }
        prepared = preparedResult.prepared;
        persistedMessage = preparedResult.persistedMessage;
        deliveryRevision = preparedResult.deliveryRevision;
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
          await preserveUploadedAttachmentsForEditor(
            queuedMessage,
            preparedResult.persistedMessage,
          );
          return true;
        }
      } catch (error) {
        console.warn("[thread-outbox] failed to upload attachments", error);
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
      if (isModelSelectionUnavailable(currentConfig, settings.modelSelection)) {
        return restoreQueuedMessage(
          persistedMessage,
          "Antigravity model unavailable. Set it up on web or desktop, or choose another model.",
        );
      }
      const sendSettings = resolveQueuedThreadSettings(
        queuedMessage,
        settings,
        currentConfig.providers,
      );
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          uploadedAttachments: prepared.attachments,
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      const { reportFailure } = makeDeliveryHelpers(queuedMessage);
      const failure = reportFailure(deliveryResult, "start-turn");
      if (failure?.action === "retry") {
        return false;
      }
      if (failure?.action === "restore") {
        return restoreQueuedMessage(persistedMessage, failure.message);
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
      return outcome === "removed";
    },
    [makeDeliveryHelpers, restoreQueuedMessage, startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    const queuedMessageIds = new Set(
      Object.values(queuedMessagesByThreadKey)
        .flat()
        .map((message) => message.messageId),
    );
    for (const messageId of acknowledgedExistingThreadMessageIdsRef.current) {
      if (!queuedMessageIds.has(messageId)) {
        acknowledgedExistingThreadMessageIdsRef.current.delete(messageId);
      }
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (
        nextQueuedMessage.creation === undefined &&
        acknowledgedExistingThreadMessageIdsRef.current.has(nextQueuedMessage.messageId)
      ) {
        if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
          continue;
        }
        beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
        void removeAcknowledgedExistingThreadMessage(
          nextQueuedMessage,
          acknowledgedExistingThreadMessageIdsRef.current,
        )
          .then((removed) => {
            if (!removed) {
              scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
              return;
            }
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
          })
          .finally(() => finishDispatchingQueuedMessage(nextQueuedMessage.messageId));
        return;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      const blockedRecovery = blockedRecoverySubscriptionsRef.current.get(
        nextQueuedMessage.messageId,
      );
      if (blockedRecovery) {
        if (blockedRecovery.message === nextQueuedMessage) {
          continue;
        }
        blockedRecoverySubscriptionsRef.current.delete(nextQueuedMessage.messageId);
        blockedRecovery.unsubscribe();
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
      });
      // The delivery action resolves first; capability checks apply only to
      // a message that will send. Checking earlier would restore a
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
        scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
        continue;
      }
      if (dispatchStep.step === "restore") {
        const attachmentError = dispatchStep.reason;
        beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
        void confirmThreadOutboxMessageQueued(nextQueuedMessage)
          .then((queued) => {
            if (
              !queued ||
              appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]
            ) {
              return true;
            }
            return restoreQueuedMessage(nextQueuedMessage, attachmentError);
          })
          .then((restored) => {
            if (!restored) {
              scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
            }
          })
          .finally(() => finishDispatchingQueuedMessage(nextQueuedMessage.messageId));
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

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId: nextQueuedMessage.messageId,
              error,
            });
            return false;
          },
        );
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return true;
        }
        // The guards evaluated before the confirmation await are stale by now:
        // the user may have opened this message in the editor. Re-read that
        // guard and defer to the next drain pass (returning true skips the
        // failure/backoff path) rather than sending a payload being edited.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
          return true;
        }
        // The shell state is equally stale. Re-run the same delivery policy
        // against the live thread snapshot so a vanished thread or newly
        // created target defers, while busy existing threads can still steer.
        if (deliveryAction === "send") {
          const liveThread = findThread(
            appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
          const liveThreadBusy =
            liveThread?.session?.status === "running" || liveThread?.session?.status === "starting";
          const liveDeliveryAction = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: liveThread !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
            threadBusy: liveThreadBusy,
          });
          if (liveDeliveryAction !== "send") {
            return true;
          }
        }
        return deliveryAction === "remove"
          ? creation !== undefined
            ? // A creation entry that survived its delivery cleanup either
              // holds edits (recover them) or the delivered payload (a
              // recovered duplicate the user can delete). Restart loses any
              // in-memory distinction, and losing edits is the worse failure,
              // so recovery is unconditional here.
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
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          scheduleQueuedMessageRetry(nextQueuedMessage.messageId);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    restoreQueuedMessage,
    scheduleQueuedMessageRetry,
    sendQueuedCreation,
    sendQueuedMessage,
    serverConfigs,
    shellStatuses,
    threads,
  ]);
}
