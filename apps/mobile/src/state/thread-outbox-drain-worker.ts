import type {
  EnvironmentProject,
  EnvironmentThreadShell,
  EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  StartThreadTurnInput,
  UpdateThreadMetadataInput,
} from "@t3tools/client-runtime/state/threads";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../lib/scopedEntities";
import {
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";

type EnvironmentCommand<Input> = (value: {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}) => Promise<AtomCommandResult<unknown, unknown>>;

type DrainThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "modelSelection" | "runtimeMode" | "interactionMode" | "session"
>;

type DrainProject = Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot">;

export interface ThreadOutboxDrainSnapshot {
  readonly queuedMessagesByThreadKey: Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>;
  readonly editingQueuedMessageIds: Readonly<Partial<Record<MessageId, true>>>;
  readonly shellStatuses: ReadonlyMap<EnvironmentId, EnvironmentShellStatus>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly threads: ReadonlyArray<DrainThread>;
  readonly projects: ReadonlyArray<DrainProject>;
  readonly canDispatch: (message: QueuedThreadMessage) => boolean;
  readonly onAttemptStart?: (message: QueuedThreadMessage) => void;
}

export type ThreadOutboxDrainResult =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Attempted";
      readonly messageId: MessageId;
      readonly delivered: boolean;
    };

export interface ThreadOutboxDrainWorkerOptions {
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
  readonly startTurn: EnvironmentCommand<StartThreadTurnInput>;
  readonly updateThreadMetadata: EnvironmentCommand<UpdateThreadMetadataInput>;
  readonly setThreadRuntimeMode: EnvironmentCommand<SetThreadRuntimeModeInput>;
  readonly setThreadInteractionMode: EnvironmentCommand<SetThreadInteractionModeInput>;
  readonly makeWorktreeBranchName?: () => string;
  readonly warn?: (message: string, details: unknown) => void;
}

function findThread(
  threads: ReadonlyArray<DrainThread>,
  message: QueuedThreadMessage,
): DrainThread | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<DrainProject>,
  message: QueuedThreadMessage,
): DrainProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export function createThreadOutboxDrainWorker(options: ThreadOutboxDrainWorkerOptions) {
  const warn =
    options.warn ??
    ((message: string, details: unknown) => {
      console.warn(message, details);
    });

  const reportFailure = (
    queuedMessage: QueuedThreadMessage,
    commandResult: AtomCommandResult<unknown, unknown>,
    stage: ThreadOutboxCommandStage,
  ): boolean => {
    if (!AsyncResult.isFailure(commandResult)) {
      return false;
    }
    const action = resolveThreadOutboxFailureAction({
      stage,
      error: Cause.squash(commandResult.cause),
      interrupted: Cause.hasInterruptsOnly(commandResult.cause),
    });
    const retry = action === "retry";
    warn("[thread-outbox] queued message delivery failed", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      stage,
      cause: commandResult.cause,
      retry,
    });
    return retry;
  };

  const removeQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    warning: string,
  ): Promise<boolean> => {
    try {
      await options.remove(queuedMessage);
      return true;
    } catch (error) {
      warn(warning, {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        error,
      });
      return false;
    }
  };

  const completeDelivery = async (
    queuedMessage: QueuedThreadMessage,
    deliveryResult: AtomCommandResult<unknown, unknown>,
  ): Promise<boolean> => {
    if (AsyncResult.isFailure(deliveryResult)) {
      return reportFailure(queuedMessage, deliveryResult, "start-turn")
        ? false
        : removeQueuedMessage(
            queuedMessage,
            "[thread-outbox] failed to discard a deterministically rejected queued message",
          );
    }
    return removeQueuedMessage(
      queuedMessage,
      "[thread-outbox] failed to remove delivered queued message",
    );
  };

  const sendQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    thread: DrainThread,
  ): Promise<boolean> => {
    const settings = resolveQueuedThreadSettings(queuedMessage, thread);

    if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
      const updateResult = await options.updateThreadMetadata({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "model-selection"),
          threadId: queuedMessage.threadId,
          modelSelection: settings.modelSelection,
        },
      });
      if (AsyncResult.isFailure(updateResult)) {
        reportFailure(queuedMessage, updateResult, "settings-sync");
        return false;
      }
    }

    if (settings.runtimeMode !== thread.runtimeMode) {
      const runtimeResult = await options.setThreadRuntimeMode({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "runtime-mode"),
          threadId: queuedMessage.threadId,
          runtimeMode: settings.runtimeMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(runtimeResult)) {
        reportFailure(queuedMessage, runtimeResult, "settings-sync");
        return false;
      }
    }

    if (settings.interactionMode !== thread.interactionMode) {
      const interactionResult = await options.setThreadInteractionMode({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "interaction-mode"),
          threadId: queuedMessage.threadId,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(interactionResult)) {
        reportFailure(queuedMessage, interactionResult, "settings-sync");
        return false;
      }
    }

    const deliveryResult = await options.startTurn({
      environmentId: queuedMessage.environmentId,
      input: {
        commandId: queuedMessage.commandId,
        threadId: queuedMessage.threadId,
        message: {
          messageId: queuedMessage.messageId,
          role: "user",
          text: queuedMessage.text,
          attachments: queuedMessage.attachments,
        },
        modelSelection: settings.modelSelection,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        createdAt: queuedMessage.createdAt,
      },
    });
    return completeDelivery(queuedMessage, deliveryResult);
  };

  const sendQueuedCreation = async (
    queuedMessage: QueuedThreadMessage,
    creation: QueuedThreadCreation,
    projectCwd: string,
  ): Promise<boolean> => {
    const modelSelection = queuedMessage.modelSelection;
    if (modelSelection === undefined) {
      return false;
    }
    const deliveryResult = await options.startTurn({
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
        modelSelection,
        runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceMode: creation.workspaceMode,
        branch: creation.branch,
        worktreePath: creation.worktreePath,
        startFromOrigin: creation.startFromOrigin ?? false,
        worktreeBranchName:
          options.makeWorktreeBranchName?.() ?? buildTemporaryWorktreeBranchName(),
      }),
    });
    return completeDelivery(queuedMessage, deliveryResult);
  };

  const drainNext = async (
    snapshot: ThreadOutboxDrainSnapshot,
  ): Promise<ThreadOutboxDrainResult> => {
    for (const [threadKey, queuedMessages] of Object.entries(snapshot.queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (
        !nextQueuedMessage ||
        snapshot.editingQueuedMessageIds[nextQueuedMessage.messageId] ||
        !snapshot.canDispatch(nextQueuedMessage)
      ) {
        continue;
      }

      const thread = findThread(snapshot.threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const shellStatus = snapshot.shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: snapshot.connectedEnvironmentIds.has(nextQueuedMessage.environmentId),
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
      });
      if (deliveryAction === "wait") {
        continue;
      }

      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(snapshot.projects, nextQueuedMessage)?.workspaceRoot ??
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

      snapshot.onAttemptStart?.(nextQueuedMessage);
      const delivered =
        deliveryAction === "remove"
          ? await removeQueuedMessage(
              nextQueuedMessage,
              "[thread-outbox] failed to remove message for a missing thread",
            )
          : creation !== undefined
            ? creationProjectCwd !== null
              ? await sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : await removeQueuedMessage(
                  nextQueuedMessage,
                  "[thread-outbox] dropped pending task for a missing project",
                )
            : thread !== undefined
              ? await sendQueuedMessage(nextQueuedMessage, thread)
              : false;
      return {
        _tag: "Attempted",
        messageId: nextQueuedMessage.messageId,
        delivered,
      };
    }
    return { _tag: "Idle" };
  };

  return { drainNext };
}
