import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";

import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import {
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  canUploadComposerAttachment,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadState,
} from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import { flattenQueuedThreadMessages, threadOutboxManager } from "./thread-outbox";
import {
  ComposerDraftPersistenceError,
  type ComposerDraft,
  composerDraftsAtom,
  composerDraftUploadSourcesAtom,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  setComposerDraftAttachmentUpload,
} from "./use-composer-drafts";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";
import { workspaceConnections } from "./workspace";

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

type ComposerAttachmentUploadRequest = {
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
};

export function composerAttachmentUploadRequests(input: {
  readonly drafts: Readonly<Record<string, Pick<ComposerDraft, "attachments" | "project">>>;
  readonly queuedMessagesByThreadKey: Parameters<typeof flattenQueuedThreadMessages>[0];
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly operableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    Parameters<typeof canUploadComposerAttachment>[1]
  >;
}): ReadonlyArray<ComposerAttachmentUploadRequest> {
  const queued = flattenQueuedThreadMessages(input.queuedMessagesByThreadKey);
  return Object.entries(input.drafts).flatMap(([key, draft]) => {
    const environmentId = composerDraftEnvironmentId(key, queued, draft);
    if (
      environmentId === null ||
      !input.connectedEnvironmentIds.has(environmentId) ||
      !input.operableEnvironmentIds.has(environmentId)
    )
      return [];
    return draft.attachments
      .filter((attachment) =>
        canUploadComposerAttachment(attachment, input.serverConfigs.get(environmentId)),
      )
      .map((attachment) => ({ environmentId, attachment }));
  });
}

// Each connected environment's session is read here so a granted or revoked
// operate scope re-syncs the queue.
const composerAttachmentUploadRequestsAtom = Atom.make((get) => {
  const connected = get(workspaceConnections.environmentsAtom).filter(
    (environment) => environment.connectionState === "connected",
  );
  const operableEnvironmentIds = new Set<EnvironmentId>();
  for (const { environmentId } of connected) {
    if (
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      )
    ) {
      operableEnvironmentIds.add(environmentId);
    }
  }
  return composerAttachmentUploadRequests({
    drafts: get(composerDraftUploadSourcesAtom),
    queuedMessagesByThreadKey: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    connectedEnvironmentIds: new Set(connected.map((environment) => environment.environmentId)),
    operableEnvironmentIds,
    serverConfigs: get(environmentServerConfigsAtom),
  });
}).pipe(Atom.withLabel("mobile:composer-attachment-upload-requests"));

/**
 * Uploads draft attachments to their environment as soon as it is connected and
 * operable. The queue follows the requests atom for its whole lifetime.
 */
export function createComposerAttachmentUploadWorker(
  requestsAtom: Atom.Atom<
    ReadonlyArray<ComposerAttachmentUploadRequest>
  > = composerAttachmentUploadRequestsAtom,
) {
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
            // Draft-save failure only costs re-upload after restart; the outbox saves references independently, so preserve accepted uploads.
            await flushComposerDrafts().catch((error: unknown) => {
              if (!(error instanceof ComposerDraftPersistenceError)) throw error;
              console.warn("[composer-attachments] could not save the uploaded reference", error);
            });
            return "persisted";
          },
        }),
      );
      release?.();
      if (AsyncResult.isFailure(prepared)) throw squashAtomCommandFailure(prepared);
      return prepared.value.status === "ready";
    },
  });
  uploadQueue = queue;
  const unsubscribe = appAtomRegistry.subscribe(requestsAtom, (requests) => queue.sync(requests), {
    immediate: true,
  });
  return {
    queue,
    dispose: () => {
      unsubscribe();
      queue.dispose();
      if (uploadQueue === queue) uploadQueue = null;
    },
  };
}

export function installComposerAttachmentUploads(): () => void {
  return createComposerAttachmentUploadWorker().dispose;
}
