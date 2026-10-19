import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import { isFileBackedComposerAttachment } from "../lib/composerImages";
import {
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  canUploadComposerAttachment,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadState,
} from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import { useServerConfigs } from "./entities";
import { flattenQueuedThreadMessages, threadOutboxManager } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import {
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  composerDraftUploadSourcesAtom,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  setComposerDraftAttachmentUpload,
} from "./use-composer-drafts";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import { readEnvironmentScope, useEnvironmentsWithScope } from "./session";

export {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "../lib/composerAttachmentUploadQueue";

export const composerAttachmentUploadsAtom = Atom.make<
  Readonly<Record<string, ComposerAttachmentUploadState>>
>({}).pipe(Atom.keepAlive);
const uploadStateAtom = Atom.family((key: string) =>
  Atom.map(composerAttachmentUploadsAtom, (states) => states[key]),
);
let uploadQueue: ReturnType<typeof createComposerAttachmentUploadQueue> | null = null;

export function useComposerAttachmentUploadState(
  environmentId: EnvironmentId | undefined,
  attachmentId: string,
) {
  return useAtomValue(
    uploadStateAtom(environmentId ? composerAttachmentUploadKey(environmentId, attachmentId) : ""),
  );
}

export function retryComposerAttachmentUpload(environmentId: EnvironmentId, attachmentId: string) {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
  uploadQueue?.retry(environmentId, attachmentId);
}

export function useComposerAttachmentUploadWorker() {
  const drafts = useAtomValue(composerDraftUploadSourcesAtom);
  const queuedMessages = useThreadOutboxMessages();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const operableEnvironments = useEnvironmentsWithScope(
    connectedEnvironments,
    AuthOrchestrationOperateScope,
  );
  const queueRef = useRef<ReturnType<typeof createComposerAttachmentUploadQueue> | null>(null);

  useEffect(() => {
    ensureComposerDraftsLoaded();
    const queue = createComposerAttachmentUploadQueue({
      onChange: (states) => appAtomRegistry.set(composerAttachmentUploadsAtom, states),
      upload: async ({ environmentId, attachment }, signal, onProgress) => {
        const release = isFileBackedComposerAttachment(attachment)
          ? retainComposerAttachmentFileForPreview(attachment)
          : undefined;
        const prepared = await settlePromise(() =>
          prepareTurnAttachments({
            environmentId,
            attachments: [attachment],
            supportsImageUploads: true,
            signal,
            onUploadProgress: (_, progress) => onProgress(progress),
            persistUploadedReferences: async ([uploaded]) => {
              if (signal.aborted || !uploaded) return "abandon";
              const queued = flattenQueuedThreadMessages(
                appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
              );
              let retained = false;
              for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
                if (
                  composerDraftEnvironmentId(key, queued, draft) === environmentId &&
                  draft.attachments.some((candidate) => candidate.id === attachment.id)
                ) {
                  retained = setComposerDraftAttachmentUpload(key, uploaded) || retained;
                }
              }
              if (!retained) return "abandon";
              // The reference is already in the in-memory draft, and Send copies it into the
              // outbox, which saves on its own. A failed draft save only costs a re-upload after
              // a restart, so it must not fail an upload the server already accepted.
              await flushComposerDrafts().catch((error: unknown) => {
                if (!(error instanceof ComposerDraftPersistenceError)) throw error;
                console.warn("[composer-attachments] could not save the uploaded reference", error);
              });
              return "persisted";
            },
          }),
        );
        release?.();
        // The upload queue owns retry and failure reporting, so a failed upload rethrows to it.
        if (AsyncResult.isFailure(prepared)) throw squashAtomCommandFailure(prepared);
        return prepared.value.status === "ready";
      },
    });
    queueRef.current = queue;
    uploadQueue = queue;
    return () => {
      queue.dispose();
      if (uploadQueue === queue) uploadQueue = null;
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const queued = flattenQueuedThreadMessages(queuedMessages);
    const connected = new Set(
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    );
    const requests = Object.entries(drafts).flatMap(([key, draft]) => {
      const environmentId = composerDraftEnvironmentId(key, queued, draft);
      if (
        environmentId === null ||
        !connected.has(environmentId) ||
        !operableEnvironments.has(environmentId)
      )
        return [];
      return draft.attachments
        .filter((attachment) =>
          canUploadComposerAttachment(attachment, serverConfigs.get(environmentId)),
        )
        .map((attachment) => ({ environmentId, attachment }));
    });
    queueRef.current?.sync(requests);
  }, [connectedEnvironments, drafts, operableEnvironments, queuedMessages, serverConfigs]);
}
