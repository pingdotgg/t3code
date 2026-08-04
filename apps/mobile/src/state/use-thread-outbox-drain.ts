import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { RegistryContext } from "@effect/atom-react";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { toUploadChatImageAttachments } from "../lib/composerImages";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../lib/scopedEntities";
import { randomHex } from "../lib/uuid";
import { environmentPresentations } from "./presentation";
import { environmentProjects } from "./projects";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  removeThreadOutboxMessage,
  threadOutboxManager,
} from "./thread-outbox";
import {
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { editingQueuedMessageIdsAtom, threadOutboxShellStatusesAtom } from "./use-thread-outbox";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

interface ThreadOutboxDrainState {
  readonly registry: AtomRegistry.AtomRegistry;
  owners: number;
  stopped: boolean;
  drainScheduled: boolean;
  activeDelivery: Promise<void> | null;
  readonly retryAttempt: Map<MessageId, number>;
  readonly retryNotBefore: Map<MessageId, number>;
  readonly retryTimers: Map<MessageId, ReturnType<typeof setTimeout>>;
  readonly releases: Array<() => void>;
}

const drainStates = new WeakMap<AtomRegistry.AtomRegistry, ThreadOutboxDrainState>();

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

function makeDeliveryHelpers(queuedMessage: QueuedThreadMessage): {
  readonly reportFailure: (
    result: AtomCommandResult<unknown, unknown>,
    stage: ThreadOutboxCommandStage,
  ) => boolean;
  readonly completeDelivery: (result: AtomCommandResult<unknown, unknown>) => Promise<boolean>;
} {
  const reportFailure = (
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
    console.warn("[thread-outbox] queued message delivery failed", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      stage,
      cause: commandResult.cause,
      retry,
    });
    return retry;
  };

  const completeDelivery = async (
    deliveryResult: AtomCommandResult<unknown, unknown>,
  ): Promise<boolean> => {
    if (reportFailure(deliveryResult, "start-turn")) {
      return false;
    }
    try {
      await removeThreadOutboxMessage(queuedMessage);
      return true;
    } catch (error) {
      console.warn("[thread-outbox] failed to remove delivered queued message", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        error,
      });
      return false;
    }
  };
  return { reportFailure, completeDelivery };
}

async function sendQueuedMessage(
  registry: AtomRegistry.AtomRegistry,
  queuedMessage: QueuedThreadMessage,
  thread: EnvironmentThreadShell,
): Promise<boolean> {
  const settings = resolveQueuedThreadSettings(queuedMessage, thread);
  const { reportFailure, completeDelivery } = makeDeliveryHelpers(queuedMessage);

  if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
    const updateResult = await runAtomCommand(
      registry,
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
      registry,
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
      registry,
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

  return completeDelivery(
    await runAtomCommand(
      registry,
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
            attachments: toUploadChatImageAttachments(queuedMessage.attachments),
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      },
      { reportFailure: false },
    ),
  );
}

async function sendQueuedCreation(
  registry: AtomRegistry.AtomRegistry,
  queuedMessage: QueuedThreadMessage,
  creation: QueuedThreadCreation,
  projectCwd: string,
): Promise<boolean> {
  const modelSelection = queuedMessage.modelSelection;
  if (modelSelection === undefined) {
    return false;
  }
  const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
  const deliveryResult = await runAtomCommand(
    registry,
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
  return completeDelivery(deliveryResult);
}

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

function drainOnce(state: ThreadOutboxDrainState): void {
  if (
    state.stopped ||
    state.activeDelivery !== null ||
    state.registry.get(dispatchingQueuedMessageIdAtom) !== null
  ) {
    return;
  }

  const queuedMessagesByThreadKey = state.registry.get(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
  );
  const editingQueuedMessageIds = state.registry.get(editingQueuedMessageIdsAtom);
  const shellStatuses = state.registry.get(threadOutboxShellStatusesAtom);
  const threads = state.registry.get(environmentThreadShells.threadShellsAtom);
  const projects = state.registry.get(environmentProjects.projectsAtom);
  const presentations = state.registry.get(environmentPresentations.presentationsAtom);

  for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
    const nextQueuedMessage = queuedMessages[0];
    if (!nextQueuedMessage || editingQueuedMessageIds[nextQueuedMessage.messageId]) {
      continue;
    }
    if ((state.retryNotBefore.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
      continue;
    }

    const thread = findThread(threads, nextQueuedMessage);
    if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
      continue;
    }
    const creation = nextQueuedMessage.creation;
    const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
    const deliveryAction = resolveThreadOutboxDeliveryAction({
      isCreation: creation !== undefined,
      threadExists: thread !== undefined,
      shellStatus,
      environmentConnected:
        presentations.get(nextQueuedMessage.environmentId)?.connection.phase === "connected",
      threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
    });
    if (deliveryAction === "wait") {
      continue;
    }

    // Prefer the live project shell, but retain the enqueue-time path so a
    // pending task remains deliverable while its project shell is unloaded.
    const creationProjectCwd =
      creation !== undefined
        ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
          creation.projectCwd ??
          null)
        : null;
    if (deliveryAction === "send" && creation !== undefined) {
      // Incomplete worktree drafts remain queued until editing finishes.
      if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
        continue;
      }
      if (creationProjectCwd === null && shellStatus !== "live") {
        continue;
      }
    }

    state.registry.set(dispatchingQueuedMessageIdAtom, nextQueuedMessage.messageId);
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

    // Enqueue publishes optimistically before its durable write settles.
    // Confirm persistence before dispatch so a rolled-back write cannot send.
    const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
      if (!queued) {
        return true;
      }
      // These guards may have changed while persistence was settling. Re-read
      // them before sending and let the next atom change restart the drain.
      if (state.registry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
        return true;
      }
      const freshThread = findThread(
        state.registry.get(environmentThreadShells.threadShellsAtom),
        nextQueuedMessage,
      );
      const freshThreadBusy =
        freshThread?.session?.status === "running" || freshThread?.session?.status === "starting";
      if (deliveryAction === "send" && creation === undefined && freshThreadBusy) {
        return true;
      }
      return deliveryAction === "remove"
        ? removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
        : creation !== undefined
          ? creationProjectCwd !== null
            ? sendQueuedCreation(state.registry, nextQueuedMessage, creation, creationProjectCwd)
            : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
          : thread !== undefined
            ? sendQueuedMessage(state.registry, nextQueuedMessage, thread)
            : Promise.resolve(false);
    });

    const completion = delivery
      .then((sent) => {
        if (sent) {
          clearRetry(state, nextQueuedMessage.messageId);
        } else {
          scheduleRetry(state, nextQueuedMessage.messageId);
        }
      })
      .catch((error) => {
        console.warn("[thread-outbox] queued message drain failed", {
          environmentId: nextQueuedMessage.environmentId,
          threadId: nextQueuedMessage.threadId,
          messageId: nextQueuedMessage.messageId,
          error,
        });
        scheduleRetry(state, nextQueuedMessage.messageId);
      })
      .finally(() => {
        if (state.registry.get(dispatchingQueuedMessageIdAtom) === nextQueuedMessage.messageId) {
          state.registry.set(dispatchingQueuedMessageIdAtom, null);
        }
        state.activeDelivery = null;
        requestDrain(state);
      });
    state.activeDelivery = completion;
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
