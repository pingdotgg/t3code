import { useSyncExternalStore } from "react";
import { Atom } from "effect/reactivity";
import { AuthOrchestrationOperateScope, CommandId } from "@t3tools/contracts";
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
import { threadEnvironment } from "./threads";
import { environmentShell } from "./shell";
import { createOfflineOutbox } from "./offlineOutbox";
import { offlineOutboxStorage } from "./offlineOutboxStorage";

export const offlineMessages = createOfflineOutbox({
  ...offlineOutboxStorage,
  canSend: ({ environmentId }) =>
    navigator.onLine &&
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
      .phase === "connected" &&
    appAtomRegistry.get(environmentShell.statusAtom(environmentId)) === "live" &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
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
    if (!message.input.bootstrap?.createThread) {
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
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: message.environmentId,
        input: {
          ...message.input,
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
    releaseDraftAttachments(message.attachments);
  },
});

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
