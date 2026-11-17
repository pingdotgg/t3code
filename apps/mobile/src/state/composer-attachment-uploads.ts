import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
} from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import { composerAttachmentUploadsAtom } from "./composer-attachment-upload-states";
import { environmentServerConfigsAtom } from "./server";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";
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

const isComposerDraftPersistenceError = Schema.is(ComposerDraftPersistenceError);

export {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
} from "../lib/composerAttachmentUploadQueue";

export { composerAttachmentUploadsAtom };
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
  /** An edited message's attachments upload through its editor draft. */
  readonly editingQueuedMessageIds: Readonly<Record<string, true>>;
  /** Every environment the client knows, so a draft key never resolves to a shorter connected prefix. */
  readonly knownEnvironmentIds: Iterable<EnvironmentId>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly operableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly serverConfigs: ReadonlyMap<
    EnvironmentId,
    Parameters<typeof canUploadComposerAttachment>[1]
  >;
}): ReadonlyArray<ComposerAttachmentUploadRequest> {
  const queued = flattenQueuedThreadMessages(input.queuedMessagesByThreadKey);
  const uploadable = (
    environmentId: EnvironmentId | null,
    attachments: ReadonlyArray<DraftComposerAttachment>,
  ): ReadonlyArray<ComposerAttachmentUploadRequest> =>
    environmentId === null ||
    !input.connectedEnvironmentIds.has(environmentId) ||
    !input.operableEnvironmentIds.has(environmentId)
      ? []
      : attachments
          .filter((attachment) =>
            canUploadComposerAttachment(attachment, input.serverConfigs.get(environmentId)),
          )
          .map((attachment) => ({ environmentId, attachment }));
  return [
    ...Object.entries(input.drafts).flatMap(([key, draft]) =>
      uploadable(
        composerDraftEnvironmentId(key, input.knownEnvironmentIds, queued, draft),
        draft.attachments,
      ),
    ),
    // Sending mid-upload hands the attachment to the outbox; requesting it here keeps that
    // upload running instead of aborting it for the outbox to start over.
    ...queued.flatMap((message) =>
      input.editingQueuedMessageIds[message.messageId]
        ? []
        : uploadable(
            message.environmentId,
            message.attachments.filter(
              (attachment) => attachment.uploadedAttachmentId === undefined,
            ),
          ),
    ),
  ];
}

function withUploadedAttachment(
  message: QueuedThreadMessage,
  uploaded: DraftComposerAttachment,
): QueuedThreadMessage | null {
  const awaiting = (attachment: DraftComposerAttachment) =>
    attachment.id === uploaded.id && attachment.uploadedAttachmentId === undefined;
  if (!message.attachments.some(awaiting)) return null;
  return {
    ...message,
    attachments: message.attachments.map((attachment) =>
      awaiting(attachment) ? uploaded : attachment,
    ),
  };
}

async function recordQueuedAttachmentUpload(
  environmentId: EnvironmentId,
  uploaded: DraftComposerAttachment,
): Promise<boolean> {
  const awaiting = () => {
    const editing = appAtomRegistry.get(editingQueuedMessageIdsAtom);
    return flattenQueuedThreadMessages(
      appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    ).flatMap((message) => {
      if (message.environmentId !== environmentId || editing[message.messageId]) return [];
      const updated = withUploadedAttachment(message, uploaded);
      return updated === null
        ? []
        : [{ updated, revision: threadOutboxRevision(message.messageId) }];
    });
  };
  let recorded = false;
  // A sibling attachment finishing at the same time bumps the revision; reread and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = awaiting();
    if (pending.length === 0) break;
    for (const { updated, revision } of pending) {
      recorded = (await updateThreadOutboxMessage(updated, revision)) || recorded;
    }
  }
  return recorded;
}

// Each connected environment's session is read here so a granted or revoked
// operate scope re-syncs the queue.
const composerAttachmentUploadRequestsAtom = Atom.make((get) => {
  const environments = get(workspaceConnections.environmentsAtom);
  const connected = environments.filter(
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
    editingQueuedMessageIds: get(editingQueuedMessageIdsAtom),
    knownEnvironmentIds: environments.map((environment) => environment.environmentId),
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
            const knownEnvironmentIds = appAtomRegistry
              .get(workspaceConnections.environmentsAtom)
              .map((environment) => environment.environmentId);
            let retained = false;
            for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
              if (
                composerDraftEnvironmentId(key, knownEnvironmentIds, queued, draft) ===
                  environmentId &&
                draft.attachments.some((candidate) => candidate.id === attachment.id)
              ) {
                retained = setComposerDraftAttachmentUpload(key, uploaded) || retained;
              }
            }
            retained = (await recordQueuedAttachmentUpload(environmentId, uploaded)) || retained;
            if (!retained) return "abandon";
            // Draft-save failure only costs re-upload after restart; the outbox saves references independently, so preserve accepted uploads.
            await flushComposerDrafts().catch((error: unknown) => {
              if (!isComposerDraftPersistenceError(error)) throw error;
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
