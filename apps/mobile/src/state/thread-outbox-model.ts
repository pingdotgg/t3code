import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import { buildDeterministicTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";

const THREAD_OUTBOX_SCHEMA_VERSION = 6;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const ThreadOutboxDeliveryHoldReasonSchema = Schema.Literals([
  "process-local-dispatch-started",
  "process-local-definite-failure",
  "deduplication-window-changed",
  "delivery-confirmed-cleanup-pending",
]);

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranchName: Schema.optional(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, 4, 5, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  // A process-local bootstrap is about to cross (or already crossed) an
  // external side-effect boundary. Automatic replay is unsafe until success
  // is proven, so the queued task stays available for explicit recovery.
  deliveryHoldReason: Schema.optional(ThreadOutboxDeliveryHoldReasonSchema),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly worktreeBranchName?: string;
  readonly startFromOrigin?: boolean;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly deliveryHoldReason?: ThreadOutboxDeliveryHoldReason;
  readonly creation?: QueuedThreadCreation;
  readonly createdAt: string;
}

export type ThreadOutboxDeliveryHoldReason = typeof ThreadOutboxDeliveryHoldReasonSchema.Type;

export function isOutcomeUnknownThreadOutboxHold(message: QueuedThreadMessage): boolean {
  return (
    message.deliveryHoldReason === "process-local-dispatch-started" ||
    message.deliveryHoldReason === "process-local-definite-failure" ||
    message.deliveryHoldReason === "deduplication-window-changed"
  );
}

export function isThreadOutboxDeliveryCleanupPending(message: QueuedThreadMessage): boolean {
  return message.deliveryHoldReason === "delivery-confirmed-cleanup-pending";
}

export function shouldQueueThreadCreationForDurableDelivery(input: {
  readonly environmentConnected: boolean;
  readonly workspaceMode: "local" | "worktree";
  readonly exactHeldReplay: boolean;
}): boolean {
  return (
    !input.environmentConnected || (input.workspaceMode === "worktree" && !input.exactHeldReplay)
  );
}

/** Compare the user-editable portion of a queued creation's dispatch payload. */
export function hasSameThreadOutboxUserPayload(
  left: QueuedThreadMessage,
  right: QueuedThreadMessage,
): boolean {
  const userPayload = (message: QueuedThreadMessage) => ({
    text: message.text.trim(),
    attachments: message.attachments,
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode,
    interactionMode: message.interactionMode,
    creation: message.creation
      ? {
          projectId: message.creation.projectId,
          workspaceMode: message.creation.workspaceMode,
          branch: message.creation.branch,
          worktreePath: message.creation.worktreePath,
          startFromOrigin: message.creation.startFromOrigin ?? false,
        }
      : undefined,
  });
  return JSON.stringify(userPayload(left)) === JSON.stringify(userPayload(right));
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export function queuedWorktreeBranchName(commandId: CommandId): string {
  return buildDeterministicTemporaryWorktreeBranchName(commandId);
}

export function resolveQueuedWorktreeBranchName(
  commandId: CommandId,
  persistedBranchName: string | undefined,
): string {
  return persistedBranchName ?? queuedWorktreeBranchName(commandId);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly held: boolean;
  readonly deliveryConfirmed?: boolean;
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.deliveryConfirmed === true) {
    // The command receipt already proved delivery. Retrying the local delete is
    // always safe and must never cross the RPC boundary again.
    return "remove";
  }
  if (input.held) {
    return "wait";
  }
  if (input.isCreation) {
    // Local-mode creation and the first turn commit atomically. An uncertain
    // process-local worktree bootstrap is held above, so any remaining queued
    // creation with an existing thread was delivered and only needs cleanup.
    if (input.threadExists) {
      return "remove";
    }
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  return input.environmentConnected && !input.threadBusy ? "send" : "wait";
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

function isDeduplicationWindowChangedCause(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return false;
  }
  if (cause._tag === "OrchestrationCommandDeduplicationWindowChangedError") {
    return true;
  }
  return (
    cause._tag === "OrchestrationDispatchCommandError" &&
    "reason" in cause &&
    cause.reason === "deduplication-window-changed"
  );
}

function isProcessLocalRestartFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentRpcUnavailableError" &&
    "cause" in error &&
    isDeduplicationWindowChangedCause(error.cause)
  );
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "ConnectionTransientError") {
      return true;
    }
    if (error._tag === "OrchestrationTurnStartPendingError") {
      return true;
    }
    if (error._tag === "EnvironmentRpcUnavailableError") {
      const cause = "cause" in error ? error.cause : null;
      return !isDeduplicationWindowChangedCause(cause);
    }
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "hold" | "discard";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (input.stage === "start-turn" && isProcessLocalRestartFailure(input.error)) {
    // A process-local worktree/setup bootstrap may have crossed an external
    // side-effect boundary before the old server died. Preserve the payload
    // for user-visible recovery, but never replay it automatically on a new
    // server process where deduplication is impossible.
    return "hold";
  }
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "discard";
}
