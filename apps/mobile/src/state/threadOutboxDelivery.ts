import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../lib/changeRequestTerm";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
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
import { managedRuntimeModeDenial } from "@t3tools/client-runtime/contract-labels";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";

import { createDebugLogger } from "../lib/debugLog";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { serializeComposerMessageForServer, uploadedComposerContext } from "../lib/composerContext";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
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
import { uploadComposerAttachmentShared } from "./composer-attachment-uploads";
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
  dispatchingQueuedMessageIdsAtom,
  editingQueuedMessageIdsAtom,
  retryingQueuedMessageIdsAtom,
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

function setQueuedMessageRetrying(queuedMessageId: MessageId, retrying: boolean): void {
  const { [queuedMessageId]: current, ...others } = appAtomRegistry.get(
    retryingQueuedMessageIdsAtom,
  );
  if ((current === true) === retrying) return;
  appAtomRegistry.set(
    retryingQueuedMessageIdsAtom,
    retrying ? { ...others, [queuedMessageId]: true } : others,
  );
}

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  // An attempt in flight is sending, even while its retry count is kept.
  setQueuedMessageRetrying(queuedMessageId, false);
  appAtomRegistry.set(dispatchingQueuedMessageIdsAtom, {
    ...appAtomRegistry.get(dispatchingQueuedMessageIdsAtom),
    [queuedMessageId]: true,
  });
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const { [queuedMessageId]: _finished, ...others } = appAtomRegistry.get(
    dispatchingQueuedMessageIdsAtom,
  );
  appAtomRegistry.set(dispatchingQueuedMessageIdsAtom, others);
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

/** Outbox or draft storage refused a step; the step decides what that means for the message. */
class ThreadOutboxStorageError extends Schema.TaggedError<ThreadOutboxStorageError>()(
  "ThreadOutboxStorageError",
  {
    operation: Schema.Literals([
      "forget-sign-out-snapshot",
      "remove-delivered",
      "remove-acknowledged",
      "remove-unsendable",
      "hand-back-to-draft",
      "restore-to-draft",
      "undo-draft-merge",
      "load-drafts",
      "flush-drafts",
      "remove-recovered",
      "remove-restored",
    ]),
    messageId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Queued message ${this.messageId} could not ${this.operation.replaceAll("-", " ")}.`;
  }
}

const storage = <A>(
  operation: ThreadOutboxStorageError["operation"],
  messageId: MessageId,
  write: () => Promise<A>,
) =>
  Effect.tryPromise({
    try: write,
    catch: (cause) => new ThreadOutboxStorageError({ operation, messageId, cause }),
  });

/** The head was not handled; back off and try it again. */
export class DeliveryRetry extends Schema.TaggedError<DeliveryRetry>()("DeliveryRetry", {}) {}

const retryDelivery = Effect.fail(new DeliveryRetry());

const isEditingQueuedMessage = (messageId: MessageId): boolean =>
  appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId] === true;

const confirmQueued = (message: QueuedThreadMessage) =>
  Effect.promise(() => confirmThreadOutboxMessageQueued(message));

const abandoned = { status: "abandoned" } as const;

export const prepareQueuedMessageAttachments = Effect.fn("ThreadOutbox.prepareAttachments")(
  function* (queuedMessage: QueuedThreadMessage) {
    if (!(yield* confirmQueued(queuedMessage))) return abandoned;
    if (!readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope)) {
      return abandoned;
    }
    const revision = threadOutboxRevision(queuedMessage.messageId);
    if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) return abandoned;
    let persistedMessage = queuedMessage;
    let deliveryRevision = revision;
    const result = yield* prepareTurnAttachments({
      environmentId: queuedMessage.environmentId,
      attachments: queuedMessage.attachments,
      supportsImageUploads: true,
      uploadAttachment: (attachment) =>
        uploadComposerAttachmentShared(queuedMessage.environmentId, attachment),
      persistUploadedReferences: Effect.fn("ThreadOutbox.persistUploadedReferences")(function* (
        draftAttachments: ReadonlyArray<DraftComposerAttachment>,
      ) {
        if (isEditingQueuedMessage(queuedMessage.messageId)) return "abandon" as const;
        const updatedMessage = { ...queuedMessage, attachments: draftAttachments };
        if (!(yield* Effect.promise(() => updateThreadOutboxMessage(updatedMessage, revision)))) {
          return "abandon" as const;
        }
        persistedMessage = updatedMessage;
        deliveryRevision = revision + 1;
        return "persisted" as const;
      }),
    });
    if (
      result.status === "abandoned" ||
      !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
    ) {
      return abandoned;
    }
    return { status: "ready", prepared: result, persistedMessage, deliveryRevision } as const;
  },
);

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

const forgetCloudQueuedMessage = (queuedMessage: QueuedThreadMessage) =>
  storage("forget-sign-out-snapshot", queuedMessage.messageId, () =>
    removeDeliveredCloudQueuedMessage(queuedMessage),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error: error.cause,
      }),
    ),
  );

export const completeQueuedMessageDelivery = Effect.fn("ThreadOutbox.completeDelivery")(function* (
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
  sequence?: number,
) {
  clearThreadComposerError(
    scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId),
    queuedMessage.messageId,
  );
  yield* forgetCloudQueuedMessage(queuedMessage);
  // Editors can acquire entries during startTurn without bumping revisions; CAS alone would lose unsaved edits.
  if (isEditingQueuedMessage(queuedMessage.messageId)) return "edited" as const;
  retainAcknowledgedThreadMessage(
    sequence === undefined ? queuedMessage : { ...queuedMessage, sequence },
  );
  const removed = yield* storage("remove-delivered", queuedMessage.messageId, () =>
    removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !isEditingQueuedMessage(queuedMessage.messageId),
    ),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("[thread-outbox] failed to remove delivered queued message", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        error: error.cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (removed === true) return "removed" as const;
  forgetAcknowledgedThreadMessage(queuedMessage);
  if (removed === null) return "failed" as const;
  threadOutboxDebug.log("delivered message was edited before cleanup", {
    environmentId: queuedMessage.environmentId,
    threadId: queuedMessage.threadId,
    messageId: queuedMessage.messageId,
  });
  return "edited" as const;
});

export const removeAcknowledgedExistingThreadMessage = Effect.fn(
  "ThreadOutbox.removeAcknowledgedMessage",
)(function* (queuedMessage: QueuedThreadMessage, acknowledgedMessageIds: Set<MessageId>) {
  yield* forgetCloudQueuedMessage(queuedMessage);
  const removed = yield* storage("remove-acknowledged", queuedMessage.messageId, () =>
    removeThreadOutboxMessage(queuedMessage),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("[thread-outbox] failed to remove acknowledged queued message", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        error: error.cause,
      }).pipe(Effect.as(false)),
    ),
  );
  if (!removed) return yield* retryDelivery;
  acknowledgedMessageIds.delete(queuedMessage.messageId);
});

/** Hands a new task edited after its launch back to the composer, then drops it from the queue. */
export const recoverEditedCreationAfterDelivery = Effect.fn("ThreadOutbox.recoverEditedCreation")(
  function* (queuedMessage: QueuedThreadMessage) {
    const kept = Object.values(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    )
      .flat()
      .find((candidate) => candidate.messageId === queuedMessage.messageId);
    if (!kept || isEditingQueuedMessage(kept.messageId)) return;
    const keptRevision = threadOutboxRevision(kept.messageId);
    const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
    const handedBack = yield* Effect.gen(function* () {
      // Merge before removal to retain file ownership; allow overflow and let send guards require trimming.
      yield* storage("hand-back-to-draft", kept.messageId, () =>
        mergeComposerDraftContent(draftKey, {
          text: kept.text,
          context: kept.context,
          attachments: [],
        }),
      );
      if (isEditingQueuedMessage(kept.messageId)) return "edited" as const;
      if (threadOutboxRevision(kept.messageId) !== keptRevision) return "changed" as const;
      const existingAttachmentIds = new Set(
        getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
      );
      appendComposerDraftAttachments(
        draftKey,
        kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
        { restore: true },
      );
      updateComposerDraftSettings(draftKey, {
        ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
        ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
        ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
      });
      // Flush before removal: append only schedules persistence, leaving the queue as the sole durable copy.
      yield* storage("flush-drafts", kept.messageId, () => flushComposerDrafts());
      return "handed-back" as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "[thread-outbox] could not hand an edited pending task to the composer",
          error.cause,
        ).pipe(Effect.as("failed" as const)),
      ),
    );
    if (handedBack === "edited") return;
    if (handedBack !== "handed-back") return yield* retryDelivery;
    if (isEditingQueuedMessage(kept.messageId)) return;
    const removed = yield* storage("remove-recovered", kept.messageId, () =>
      removeThreadOutboxMessage(kept, keptRevision, () => !isEditingQueuedMessage(kept.messageId)),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "[thread-outbox] could not remove recovered pending task",
          error.cause,
        ).pipe(Effect.as(false)),
      ),
    );
    if (!removed) return yield* retryDelivery;
  },
);

/**
 * Hands an undeliverable message back to its draft with the reason. "blocked" means the draft
 * cannot take it yet (attachment cap); "deferred" means an editor or newer write owns it.
 */
export const restoreRejectedQueuedMessage = Effect.fn("ThreadOutbox.restoreRejectedMessage")(
  function* (queuedMessage: QueuedThreadMessage, message: string) {
    const draftKey = recoveryDraftKey(queuedMessage);
    const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
    const editing = () => isEditingQueuedMessage(queuedMessage.messageId);
    // Until the queue drops the message, a failure undoes the merge, keeping concurrent edits.
    let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null =
      null;
    const undo = (snapshot: ComposerDraft, merged: ComposerDraft) =>
      storage("undo-draft-merge", queuedMessage.messageId, () =>
        undoComposerDraftMerge(draftKey, snapshot, merged),
      );
    return yield* Effect.gen(function* () {
      if (editing() || !(yield* confirmQueued(queuedMessage)) || editing()) {
        return "deferred" as const;
      }
      const revision = threadOutboxRevision(queuedMessage.messageId);
      if (queuedMessage.restoreToDraft === false) {
        const removed = yield* storage("remove-unsendable", queuedMessage.messageId, () =>
          removeThreadOutboxMessage(queuedMessage, revision, () => !editing()),
        );
        if (!removed) return "deferred" as const;
        setThreadComposerError(threadKey, message, queuedMessage.messageId);
        return "restored" as const;
      }
      yield* storage("load-drafts", queuedMessage.messageId, () => waitForComposerDraftsLoaded());
      if (editing()) return "deferred" as const;
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
          m(
            msg(
              "Remove attachments from the draft before restoring this message. Messages can contain at most {max} attachments.",
              { max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS },
            ),
          ),
          queuedMessage.messageId,
        );
        return "blocked" as const;
      }

      const withdraw = (merged: ComposerDraft) =>
        Effect.sync(() => clearThreadComposerError(threadKey, queuedMessage.messageId)).pipe(
          Effect.andThen(undo(originalDraft, merged)),
          Effect.as("deferred" as const),
        );
      if (!queuedMessage.creation) {
        setThreadComposerError(threadKey, message, queuedMessage.messageId);
      }
      stampRecoveryDraftProject(queuedMessage, draftKey);
      // The merge publishes even when persisting it fails, so the rollback is captured either way.
      yield* storage("restore-to-draft", queuedMessage.messageId, () =>
        mergeComposerDraftContent(draftKey, {
          text: queuedMessage.text,
          context: queuedMessage.context,
          attachments: queuedMessage.attachments,
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rollback = { snapshot: originalDraft, merged: getComposerDraftSnapshot(draftKey) };
          }),
        ),
      );
      if (editing()) return yield* withdraw(getComposerDraftSnapshot(draftKey));
      updateComposerDraftSettings(draftKey, {
        ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
        ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
        ...(queuedMessage.interactionMode
          ? { interactionMode: queuedMessage.interactionMode }
          : {}),
        ...(queuedMessage.freshContext ? { freshContext: true } : {}),
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
      yield* storage("flush-drafts", queuedMessage.messageId, () => flushComposerDrafts());
      if (editing() || !(yield* confirmQueued(queuedMessage)) || editing()) {
        return yield* withdraw(restoredDraft);
      }
      const removed = yield* storage("remove-restored", queuedMessage.messageId, () =>
        removeThreadOutboxMessage(queuedMessage, revision, () => !editing()),
      );
      if (!removed) return yield* withdraw(restoredDraft);
      // After queue removal, the draft owns content and must never roll back.
      rollback = null;
      if (queuedMessage.creation) {
        clearThreadComposerError(threadKey, queuedMessage.messageId);
        recordPendingThreadCreationOutcome({
          kind: "failed",
          message: queuedMessage,
          reason: message,
        });
      }
      return "restored" as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const pending: typeof rollback = rollback;
          if (pending !== null) {
            yield* undo(pending.snapshot, pending.merged).pipe(
              Effect.catch((undoError) =>
                Effect.logWarning(
                  "[thread-outbox] failed to persist a recovery rollback",
                  undoError.cause,
                ),
              ),
            );
          }
          yield* Effect.logWarning(
            "[thread-outbox] failed to restore an undeliverable message",
            error.cause,
          );
          setThreadComposerError(
            threadKey,
            errorDisplayMessage(error.cause, m) ??
              m(msg("The unsent message could not be restored.")),
            queuedMessage.messageId,
          );
          return "retry" as const;
        }),
      ),
    );
  },
);

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

const preserveUploadedAttachmentsForEditor = Effect.fn(
  "ThreadOutbox.preserveUploadedAttachmentsForEditor",
)(function* (originalMessage: QueuedThreadMessage, uploadedMessage: QueuedThreadMessage) {
  if (!originalMessage.creation) return;
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
  if (!changed) return;
  replaceComposerDraftAttachments(draftKey, nextAttachments);
  yield* Effect.promise(() => flushComposerDrafts());
});

// Everything delivery decides from. Each queued environment's session is read
// here so a granted or revoked operate scope wakes delivery.

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

const deliveryCommand = <W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Effect.Effect<AtomCommandResult<A, E>> =>
  Effect.promise(() => runAtomCommand(appAtomRegistry, command, input, { reportFailure: false }));

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
    message: errorDisplayMessage(error, m) ?? m(msg("The message could not be sent.")),
  };
}

interface ThreadOutboxRetry {
  readonly attempt: number;
  readonly notBefore: number;
}

/** A thread's delivery fiber; `retiring` once interrupted, until the fiber has exited. */
interface ThreadFiber {
  readonly wake: Latch.Latch;
  fiber: Fiber.Fiber<never> | undefined;
  retiring: boolean;
}

/** What a thread's delivery fiber does next with the head of its queue. */
type ThreadDeliveryStep =
  /** Nothing to send until an input changes, or until `until` when a backoff is running. */
  | { readonly _tag: "Wait"; readonly until?: number }
  /** The head failed without a send; back off before trying it again. */
  | { readonly _tag: "Backoff"; readonly messageId: MessageId }
  | {
      readonly _tag: "Dispatch";
      readonly messageId: MessageId;
      /** Succeeds once the message is handled (sent, removed or handed back). */
      readonly run: Effect.Effect<void, DeliveryRetry>;
    };

/**
 * Delivers queued thread messages, one fiber per thread so a slow send in one thread never
 * holds another. Each fiber sends its thread's head message in order, backs off after a
 * failure, and otherwise waits until an input changes (outbox, locks, shells, projects,
 * configs, connections, scopes).
 */
export function createThreadOutboxDelivery(): {
  readonly drain: () => void;
  readonly dispose: () => void;
} {
  let disposed = false;
  const retries = new Map<MessageId, ThreadOutboxRetry>();
  let readyEnvironmentIds = new Set<EnvironmentId>();
  // Existing-thread turns the server accepted but whose outbox removal has
  // not landed; the next pass retries only the removal, never the send.
  const acknowledgedExistingThreadMessageIds = new Set<MessageId>();
  // Revision and workspace each new task's launch carried. Launch replays by command id, so an
  // unedited task whose reply was lost is resent in that workspace, not handed back.
  const launchedCreations = new Map<
    MessageId,
    { readonly revision: number; readonly workspace: QueuedThreadCreation }
  >();
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
    const attempt = (retries.get(messageId)?.attempt ?? 0) + 1;
    retries.set(messageId, {
      attempt,
      notBefore: Date.now() + threadOutboxRetryDelayMs(attempt),
    });
    setQueuedMessageRetrying(messageId, true);
  };

  const clearRetry = (messageId: MessageId): void => {
    if (!retries.delete(messageId)) return;
    setQueuedMessageRetrying(messageId, false);
  };

  // An over-cap draft blocks recovery until the user changes its attachments;
  // parking on the draft avoids hammering the restore with backoff retries.
  const restoreQueuedMessage = Effect.fn("ThreadOutbox.restoreQueuedMessage")(function* (
    queuedMessage: QueuedThreadMessage,
    message: string,
  ) {
    const result = yield* restoreRejectedQueuedMessage(queuedMessage, message);
    if (result === "retry") return yield* retryDelivery;
    if (result !== "blocked" || disposed || blockedRecoveries.has(queuedMessage.messageId)) {
      return;
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
      wakeThreads();
    });
    blockedRecoveries.set(queuedMessage.messageId, { message: queuedMessage, unsubscribe });
  });

  const sendQueuedMessage = Effect.fn("ThreadOutbox.sendQueuedMessage")(function* (
    queuedMessage: QueuedThreadMessage,
    thread: EnvironmentThreadShell,
  ) {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return;
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return yield* retryDelivery;
    const settings = resolveQueuedThreadSettings(queuedMessage, thread, serverConfig.providers);
    if (isModelSelectionUnavailable(serverConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return yield* restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    // The server would refuse this mode in settings sync, which retries forever; stop first.
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
      m,
    );
    if (runtimeModeDenial !== undefined) {
      return yield* restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }

    if (settings.runtimeMode !== thread.runtimeMode) {
      if (!hasAccess()) return;
      const runtimeResult = yield* deliveryCommand(threadEnvironment.setRuntimeMode, {
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
        return yield* retryDelivery;
      }
    }

    if (settings.interactionMode !== thread.interactionMode) {
      if (!hasAccess()) return;
      const interactionResult = yield* deliveryCommand(threadEnvironment.setInteractionMode, {
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
        return yield* retryDelivery;
      }
    }

    if (!hasAccess()) return;
    // Waiting on the shared upload is the one part of a send that may be cut short.
    const preparedExit = yield* Effect.exit(
      Effect.interruptible(prepareQueuedMessageAttachments(queuedMessage)),
    );
    if (Exit.isFailure(preparedExit)) {
      if (Cause.hasInterruptsOnly(preparedExit.cause)) return yield* Effect.interrupt;
      const error = Cause.squash(preparedExit.cause);
      if (!hasAccess()) return;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return yield* restoreQueuedMessage(
          queuedMessage,
          errorDisplayMessage(error, m) ?? m(msg("An attachment could not upload.")),
        );
      }
      return yield* retryDelivery;
    }
    if (preparedExit.value.status === "abandoned") return;
    const { prepared, persistedMessage, deliveryRevision } = preparedExit.value;
    if (isEditingQueuedMessage(queuedMessage.messageId)) {
      yield* preserveUploadedAttachmentsForEditor(queuedMessage, persistedMessage);
      return;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return yield* retryDelivery;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return yield* restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (queuedMessage.compactBeforeSend === true) {
      if (!hasAccess()) return;
      // Queued, since steering a running turn with a compaction is rejected.
      const compactionResult = yield* deliveryCommand(threadEnvironment.startTurn, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "compact"),
          creationSource: "mobile",
          threadId: queuedMessage.threadId,
          message: {
            messageId: MessageId.make(`${queuedMessage.messageId}:compact`),
            role: "user",
            text: "/compact",
            attachments: [],
            idleCompaction: "onReturn",
          },
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          createdAt: queuedMessage.createdAt,
          dispatchMode: "queue",
          resendAfterSocketLoss: false,
        },
      });
      if (AsyncResult.isFailure(compactionResult) && !hasAccess()) return;
      const compactionFailure = reportCommandFailure(queuedMessage, compactionResult, "start-turn");
      if (compactionFailure?.action === "retry") return yield* retryDelivery;
      if (compactionFailure?.action === "restore") {
        return yield* restoreQueuedMessage(persistedMessage, compactionFailure.message);
      }
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) return;
    }
    if (!hasAccess()) return;
    const deliveryResult = yield* deliveryCommand(threadEnvironment.startTurn, {
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
        titleSeed: deriveThreadTitleSeed(
          { text: queuedMessage.text, attachments: queuedMessage.attachments },
          m,
        ),
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt: queuedMessage.createdAt,
        dispatchMode: queuedMessage.dispatchMode ?? "start",
        ...(queuedMessage.freshContext ? { freshContext: true } : {}),
        resendAfterSocketLoss: false,
      },
    });
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return yield* retryDelivery;
    }
    if (failure?.action === "restore") {
      return yield* restoreQueuedMessage(persistedMessage, failure.message);
    }
    acknowledgedExistingThreadMessageIds.add(persistedMessage.messageId);
    const outcome = yield* completeQueuedMessageDelivery(
      persistedMessage,
      deliveryRevision,
      deliveredSequence(deliveryResult),
    );
    if (outcome !== "removed") return yield* retryDelivery;
    acknowledgedExistingThreadMessageIds.delete(persistedMessage.messageId);
  });

  const sendQueuedCreation = Effect.fn("ThreadOutbox.sendQueuedCreation")(function* (
    queuedMessage: QueuedThreadMessage,
    creation: QueuedThreadCreation,
    projectCwd: string,
  ) {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return;
    const modelSelection = queuedMessage.modelSelection;
    if (modelSelection === undefined) {
      return yield* retryDelivery;
    }
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return yield* retryDelivery;
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
      return yield* restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
      m,
    );
    if (runtimeModeDenial !== undefined) {
      return yield* restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }
    // Waiting on the shared upload is the one part of a send that may be cut short.
    const preparedExit = yield* Effect.exit(
      Effect.interruptible(prepareQueuedMessageAttachments(queuedMessage)),
    );
    if (Exit.isFailure(preparedExit)) {
      if (Cause.hasInterruptsOnly(preparedExit.cause)) return yield* Effect.interrupt;
      const error = Cause.squash(preparedExit.cause);
      if (!hasAccess()) return;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return yield* restoreQueuedMessage(
          queuedMessage,
          errorDisplayMessage(error, m) ?? m(msg("An attachment could not upload.")),
        );
      }
      return yield* retryDelivery;
    }
    if (preparedExit.value.status === "abandoned") return;
    const { prepared, persistedMessage, deliveryRevision } = preparedExit.value;
    if (isEditingQueuedMessage(queuedMessage.messageId)) {
      yield* preserveUploadedAttachmentsForEditor(queuedMessage, persistedMessage);
      return;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return yield* retryDelivery;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, creation.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        creation.projectId,
      );
      return yield* restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (!hasAccess()) return;
    let workspace = creation;
    const launched = launchedCreations.get(persistedMessage.messageId);
    if (launched?.revision === deliveryRevision) {
      workspace = launched.workspace;
    } else if (creation.pullRequestReference) {
      const checkout = yield* deliveryCommand(gitEnvironment.preparePullRequestThread, {
        environmentId: queuedMessage.environmentId,
        input: { cwd: projectCwd, reference: creation.pullRequestReference, mode: "worktree" },
      });
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision) || !hasAccess())
        return;
      const failure = reportCommandFailure(queuedMessage, checkout, "start-turn");
      if (failure?.action === "retry") return yield* retryDelivery;
      if (failure?.action === "restore")
        return yield* restoreQueuedMessage(persistedMessage, failure.message);
      if (!AsyncResult.isSuccess(checkout)) return yield* retryDelivery;
      if (!checkout.value.worktreePath || !checkout.value.isOnPullRequestHead) {
        const term = changeRequestTermKind(
          (
            sourceControlClients.findByChangeRequestUrl(creation.pullRequestReference) ??
            sourceControlClients.get(undefined)
          ).changeRequest,
        );
        return yield* restoreQueuedMessage(
          persistedMessage,
          m(
            msg(
              "{term, select, mr {The MR worktree has local changes and could not update to the MR head. Resolve them before trying again.} cr {The change request worktree has local changes and could not update to the change request head. Resolve them before trying again.} other {The PR worktree has local changes and could not update to the PR head. Resolve them before trying again.}}",
              { term },
            ),
          ),
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
    launchedCreations.set(persistedMessage.messageId, { revision: deliveryRevision, workspace });
    const deliveryResult = yield* deliveryCommand(threadEnvironment.startTurn, {
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
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return yield* retryDelivery;
    }
    if (failure?.action === "restore") {
      return yield* restoreQueuedMessage(persistedMessage, failure.message);
    }
    recordPendingThreadCreationOutcome({ kind: "delivered", message: persistedMessage });
    const outcome = yield* completeQueuedMessageDelivery(
      persistedMessage,
      deliveryRevision,
      deliveredSequence(deliveryResult),
    );
    if (outcome === "edited") {
      if (isEditingQueuedMessage(queuedMessage.messageId)) return;
      return yield* recoverEditedCreationAfterDelivery(persistedMessage);
    }
    if (outcome !== "removed") return yield* retryDelivery;
  });

  /** The head of one thread's queue, as the inputs stand now. */
  function nextStep(
    threadKey: string,
    queuedMessages: ReadonlyArray<QueuedThreadMessage>,
    inputs: Atom.Type<typeof deliveryInputsAtom>,
  ): ThreadDeliveryStep {
    const {
      editingQueuedMessageIds,
      shellStatuses,
      threads,
      projects,
      serverConfigs,
      connectedEnvironments,
      operableEnvironments,
    } = inputs;
    const nextQueuedMessage = queuedMessages[0];
    if (!nextQueuedMessage) {
      return { _tag: "Wait" };
    }
    const messageId = nextQueuedMessage.messageId;
    if (
      nextQueuedMessage.creation === undefined &&
      acknowledgedExistingThreadMessageIds.has(messageId)
    ) {
      if (retryNotBefore(messageId) > Date.now()) {
        return { _tag: "Wait", until: retryNotBefore(messageId) };
      }
      return {
        _tag: "Dispatch",
        messageId,
        run: removeAcknowledgedExistingThreadMessage(
          nextQueuedMessage,
          acknowledgedExistingThreadMessageIds,
        ),
      };
    }
    if (editingQueuedMessageIds[messageId]) {
      return { _tag: "Wait" };
    }
    const blockedRecovery = blockedRecoveries.get(messageId);
    if (blockedRecovery) {
      if (blockedRecovery.message === nextQueuedMessage) {
        return { _tag: "Wait" };
      }
      blockedRecoveries.delete(messageId);
      blockedRecovery.unsubscribe();
    }
    if (retryNotBefore(messageId) > Date.now()) {
      return { _tag: "Wait", until: retryNotBefore(messageId) };
    }
    let thread = findThread(threads, nextQueuedMessage);
    if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
      return { _tag: "Wait" };
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
    const resendLaunch =
      creation !== undefined &&
      launchedCreations.get(messageId)?.revision === threadOutboxRevision(messageId);
    const deliveryAction = resolveThreadOutboxDeliveryAction({
      isCreation: creation !== undefined,
      // A resend goes through the same gates as the first launch.
      threadExists: thread !== undefined && !resendLaunch,
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
      // An empty family read changes no merged row, so nothing else would wake the thread.
      return { _tag: "Backoff", messageId };
    }
    if (deliveryAction === "send" && !operableEnvironments.has(nextQueuedMessage.environmentId)) {
      return { _tag: "Wait" };
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
      return { _tag: "Wait" };
    }
    if (dispatchStep.step === "retry") {
      return { _tag: "Backoff", messageId };
    }
    if (dispatchStep.step === "restore") {
      const attachmentError = dispatchStep.reason;
      return {
        _tag: "Dispatch",
        messageId,
        run: Effect.gen(function* () {
          if (!(yield* confirmQueued(nextQueuedMessage)) || isEditingQueuedMessage(messageId)) {
            return;
          }
          yield* restoreQueuedMessage(nextQueuedMessage, attachmentError);
        }),
      };
    }
    const creationProjectCwd =
      creation !== undefined
        ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
          creation.projectCwd ??
          null)
        : null;
    if (deliveryAction === "send" && creation !== undefined) {
      if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
        return { _tag: "Wait" };
      }
      if (creationProjectCwd === null && shellStatus !== "live") {
        return { _tag: "Wait" };
      }
    }

    const removeQueuedMessage = (warning: string) =>
      storage("remove-unsendable", messageId, () =>
        removeThreadOutboxMessage(nextQueuedMessage),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(warning, {
            environmentId: nextQueuedMessage.environmentId,
            threadId: nextQueuedMessage.threadId,
            messageId,
            error: error.cause,
          }).pipe(Effect.andThen(retryDelivery)),
        ),
        Effect.asVoid,
      );
    // Confirm durability before sending; optimistic enqueue can still roll back on write failure.
    const run = Effect.gen(function* () {
      if (!(yield* confirmQueued(nextQueuedMessage))) return;
      // An editor that took the message after confirmation owns it; that is not a failure.
      if (isEditingQueuedMessage(messageId)) return;
      if (deliveryAction === "send") {
        const liveThread = findThread(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          nextQueuedMessage,
        );
        const liveDeliveryAction = resolveThreadOutboxDeliveryAction({
          isCreation: creation !== undefined,
          threadExists: liveThread !== undefined && !resendLaunch,
          shellStatus,
          environmentConnected: environment?.connectionState === "connected",
        });
        if (liveDeliveryAction !== "send") return;
      }
      if (deliveryAction === "remove") {
        // Edited since launch, or launched before a restart that lost the revision: hand it back.
        return yield* creation !== undefined
          ? recoverEditedCreationAfterDelivery(nextQueuedMessage)
          : removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread");
      }
      if (creation !== undefined) {
        return yield* creationProjectCwd !== null
          ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
          : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project");
      }
      return yield* thread !== undefined
        ? sendQueuedMessage(nextQueuedMessage, thread)
        : retryDelivery;
    });
    return { _tag: "Dispatch", messageId, run };
  }

  // One fiber per thread with queued messages. Opening a thread's latch wakes its fiber to
  // reconsider its head; the fiber closes it before reading the inputs, so no wake is lost.
  // An entry outlives its interrupted fiber until that fiber exits, so a thread never has two.
  const threadFibers = new Map<string, ThreadFiber>();

  const deliverThread = (threadKey: string, wake: Latch.Latch) =>
    Effect.forever(
      Effect.gen(function* () {
        yield* wake.close;
        const inputs = appAtomRegistry.get(deliveryInputsAtom);
        const step = nextStep(threadKey, inputs.queuedMessagesByThreadKey[threadKey] ?? [], inputs);
        if (step._tag === "Backoff") {
          scheduleRetry(step.messageId);
          return;
        }
        if (step._tag === "Wait") {
          if (step.until === undefined) {
            yield* wake.await;
            return;
          }
          const now = yield* Clock.currentTimeMillis;
          yield* wake.await.pipe(
            Effect.timeoutOrElse({
              duration: Math.max(0, step.until - now),
              orElse: () => Effect.void,
            }),
          );
          return;
        }
        // A send that started finishes, even when its thread leaves the queue meanwhile; only
        // its wait on a shared upload stops early.
        beginDispatchingQueuedMessage(step.messageId);
        const sent = yield* step.run.pipe(
          Effect.as(true),
          Effect.catchTags({ DeliveryRetry: () => Effect.succeed(false) }),
          // A send that throws backs off like any failure, not straight back into the send.
          Effect.catchDefect((error) =>
            Effect.logWarning("[thread-outbox] queued message delivery threw", {
              messageId: step.messageId,
              error,
            }).pipe(Effect.as(false)),
          ),
          Effect.ensuring(Effect.sync(() => finishDispatchingQueuedMessage(step.messageId))),
          Effect.uninterruptible,
        );
        if (sent) clearRetry(step.messageId);
        else scheduleRetry(step.messageId);
      }),
    );

  function wakeThreads(): void {
    for (const { wake } of threadFibers.values()) wake.openUnsafe();
  }

  /** Starts a fiber for each thread with queued messages, stops the rest, and wakes them all. */
  function onInputs(): void {
    if (disposed) return;
    const { queuedMessagesByThreadKey, serverConfigs, connectedEnvironments } =
      appAtomRegistry.get(deliveryInputsAtom);
    const queued = Object.values(queuedMessagesByThreadKey).flat();
    // Failures while an environment was unreachable say nothing about it now; a backoff
    // started then would hold a message for up to its full delay after reconnecting.
    const ready = new Set(
      connectedEnvironments
        .filter(
          (environment) =>
            environment.connectionState === "connected" &&
            serverConfigs.has(environment.environmentId),
        )
        .map((environment) => environment.environmentId),
    );
    for (const message of queued) {
      if (ready.has(message.environmentId) && !readyEnvironmentIds.has(message.environmentId)) {
        clearRetry(message.messageId);
      }
    }
    readyEnvironmentIds = ready;

    const queuedMessageIds = new Set(queued.map((message) => message.messageId));
    for (const messageId of acknowledgedExistingThreadMessageIds) {
      if (!queuedMessageIds.has(messageId)) acknowledgedExistingThreadMessageIds.delete(messageId);
    }
    for (const messageId of launchedCreations.keys()) {
      if (!queuedMessageIds.has(messageId)) launchedCreations.delete(messageId);
    }
    for (const [messageId, release] of familyMounts) {
      if (!queuedMessageIds.has(messageId)) {
        release();
        familyMounts.delete(messageId);
      }
    }

    for (const [threadKey, entry] of threadFibers) {
      if ((queuedMessagesByThreadKey[threadKey]?.length ?? 0) > 0 || entry.retiring) continue;
      entry.retiring = true;
      if (entry.fiber !== undefined) Effect.runFork(Fiber.interrupt(entry.fiber));
    }
    for (const [threadKey, messages] of Object.entries(queuedMessagesByThreadKey)) {
      if (messages.length === 0 || threadFibers.has(threadKey)) continue;
      // Registered before the fiber starts: its first step runs synchronously and can re-enter here.
      const entry: ThreadFiber = {
        wake: Latch.makeUnsafe(true),
        fiber: undefined,
        retiring: false,
      };
      threadFibers.set(threadKey, entry);
      const fiber = Effect.runFork(deliverThread(threadKey, entry.wake));
      entry.fiber = fiber;
      fiber.addObserver(() => {
        if (threadFibers.get(threadKey) !== entry) return;
        threadFibers.delete(threadKey);
        // A message queued while this fiber finished its send starts the next fiber now.
        if (!disposed) onInputs();
      });
      if (entry.retiring) Effect.runFork(Fiber.interrupt(fiber));
    }
    wakeThreads();
  }

  const stopDelivering = appAtomRegistry.subscribe(deliveryInputsAtom, onInputs, {
    immediate: true,
  });
  const stopCollectingOutcomes = appAtomRegistry.subscribe(
    settledCreationOutcomeKeysAtom,
    (threadKeys) => {
      for (const threadKey of threadKeys) clearPendingThreadCreationOutcome(threadKey);
    },
    { immediate: true },
  );

  return {
    drain: wakeThreads,
    dispose: () => {
      disposed = true;
      stopDelivering();
      stopCollectingOutcomes();
      for (const { fiber } of threadFibers.values()) {
        if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
      }
      threadFibers.clear();
      retries.clear();
      appAtomRegistry.set(retryingQueuedMessageIdsAtom, {});
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
      m(msg("Some queued messages could not be loaded")),
      m(
        msg(
          "Unreadable records and attachment files are still saved. Other messages can still be sent.",
        ),
      ),
      [
        { text: m(msg("Dismiss")), style: "cancel" },
        { text: m(msg("Retry")), onPress: () => loadThreadOutbox(isActive) },
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
