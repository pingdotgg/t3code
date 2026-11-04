import { useSyncExternalStore } from "react";
import { Atom } from "effect/reactivity";
import { AuthOrchestrationOperateScope, CommandId } from "@t3tools/contracts";
import { DraftId, restoreFailedDraftThread, useComposerDraftStore } from "../composerDraftStore";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { toastManager } from "../components/ui/toast";
import { environmentPresentations } from "./presentation";
import { environmentSession, readEnvironmentScope } from "./session";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadEnvironment, environmentThreadShells } from "./threads";
import { environmentShell } from "./shell";
import { createOfflineOutbox } from "./offlineOutbox";
import { offlineOutboxStorage } from "./offlineOutboxStorage";
import { waitForAtomValue } from "./waitForAtomValue";

export const offlineMessages = createOfflineOutbox({
  ...offlineOutboxStorage,
  canSend: ({ environmentId }) =>
    navigator.onLine &&
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
      .phase === "connected" &&
    appAtomRegistry.get(environmentShell.statusAtom(environmentId)) === "live" &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  prepare: (message) => {
    if (!message.inheritedBootstrap) return message;
    const { bootstrap: queuedBootstrap, ...turnInput } = message.input;
    let bootstrap = queuedBootstrap;
    if (bootstrap) {
      const existing = appAtomRegistry.get(
        environmentThreadShells.threadShellAtom(
          scopeThreadRef(message.environmentId, message.input.threadId),
        ),
      );
      if (existing) {
        const { createThread: _, ...remaining } = bootstrap;
        bootstrap = existing.latestRun === null ? remaining : undefined;
      }
    }
    return {
      ...message,
      inheritedBootstrap: false,
      input: { ...turnInput, ...(bootstrap ? { bootstrap } : {}) },
    };
  },
  send: async (message) => {
    for (const attachment of message.attachments) {
      const input = { environmentId: message.environmentId, image: attachment };
      if (readAttachmentUpload(attachment.id)?.status === "failed") retryAttachmentUpload(input);
      else startAttachmentUpload(input);
    }
    await awaitAttachmentUploads(message.attachments.map((attachment) => attachment.id));
    const attachments = getUploadedAttachments({
      environmentId: message.environmentId,
      images: message.attachments,
    });
    if (!attachments) throw new Error("Attachments could not be uploaded. Retry when connected.");
    const context = remapComposerContextAttachments(
      message.input.message.context,
      message.attachments,
      attachments,
    );
    const { bootstrap, ...turnInput } = message.input;
    if (!bootstrap?.createThread) {
      const threadRef = scopeThreadRef(message.environmentId, message.input.threadId);
      if (
        appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.runtimeMode !==
        message.input.runtimeMode
      ) {
        const runtimeResult = await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.setRuntimeMode,
          {
            environmentId: message.environmentId,
            input: {
              threadId: message.input.threadId,
              runtimeMode: message.input.runtimeMode,
              commandId: CommandId.make(message.input.commandId + ":runtime-mode"),
            },
          },
          { reportFailure: false },
        );
        if (runtimeResult._tag === "Failure") throw squashAtomCommandFailure(runtimeResult);
      }
      if (
        appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))?.interactionMode !==
        message.input.interactionMode
      ) {
        const interactionResult = await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.setInteractionMode,
          {
            environmentId: message.environmentId,
            input: {
              threadId: message.input.threadId,
              interactionMode: message.input.interactionMode,
              commandId: CommandId.make(message.input.commandId + ":interaction-mode"),
            },
          },
          { reportFailure: false },
        );
        if (interactionResult._tag === "Failure") throw squashAtomCommandFailure(interactionResult);
      }
    }
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: message.environmentId,
        input: {
          ...turnInput,
          ...(bootstrap ? { bootstrap } : {}),
          message: {
            ...message.input.message,
            attachments,
            ...(context ? { context } : {}),
          },
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const shellSynced = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentShell.stateValueAtom(message.environmentId),
      predicate: (shell) =>
        shell.snapshot._tag === "Some" &&
        shell.snapshot.value.snapshotSequence >= (result.value.sequence ?? 0),
      timeoutMs: 5_000,
    });
    if (!shellSynced)
      throw new Error("Environment data has not synchronized. Reconnect and retry.");
    releaseDraftAttachments(message.attachments);
  },
});

export async function cancelOfflineMessage(id: string) {
  const message = await offlineMessages.remove(id);
  if (!message?.input.bootstrap?.createThread) return;
  const threadRef = scopeThreadRef(message.environmentId, message.input.threadId);
  if (
    offlineMessages
      .getSnapshot()
      .some(
        (entry) =>
          entry.environmentId === message.environmentId &&
          entry.input.threadId === message.input.threadId,
      ) ||
    appAtomRegistry.get(environmentThreadShells.threadShellAtom(threadRef))
  )
    return;
  for (const [draftId, draft] of Object.entries(
    useComposerDraftStore.getState().draftThreadsByThreadKey,
  )) {
    if (
      draft.environmentId === message.environmentId &&
      draft.threadId === message.input.threadId
    ) {
      restoreFailedDraftThread(DraftId.make(draftId), draft, draft.threadId);
    }
  }
}

export function useOfflineMessages() {
  return useSyncExternalStore(offlineMessages.subscribe, offlineMessages.getSnapshot);
}

let draining: Promise<void> | undefined;
let drainRequested = false;
export function deliverOfflineMessages() {
  if (draining) {
    drainRequested = true;
    return draining;
  }
  const drain = async () => {
    await offlineMessages.load();
    await offlineMessages.drain();
  };
  draining = (
    navigator.locks
      ? navigator.locks.request("t3code:offline-outbox", async () => {
          await drain();
        })
      : drain()
  )
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not read or save offline messages",
        description: error instanceof Error ? error.message : undefined,
      });
    })
    .finally(() => {
      draining = undefined;
      if (drainRequested) {
        drainRequested = false;
        void deliverOfflineMessages();
      }
    });
  return draining;
}

export function startOfflineMessageDelivery() {
  const connections = Atom.make((get) => {
    const environments = get(environmentPresentations.presentationsAtom);
    const sessions = [...environments.keys()].map((environmentId) => [
      get(environmentSession.sessionStateAtom(environmentId)),
      get(environmentShell.statusAtom(environmentId)),
    ]);
    return { environments, sessions };
  });
  appAtomRegistry.subscribe(
    connections,
    () => {
      void deliverOfflineMessages();
    },
    { immediate: true },
  );
  window.addEventListener("online", () => {
    void deliverOfflineMessages();
  });
}

const subscribeNetwork = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
export function useNetworkOffline() {
  return useSyncExternalStore(subscribeNetwork, () => !navigator.onLine);
}
