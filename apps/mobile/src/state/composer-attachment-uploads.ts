import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { uploadComposerAttachment } from "../lib/attachmentUpload";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import {
  uploadError,
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  canUploadComposerAttachment,
  createComposerAttachmentUploadQueue,
  type ComposerAttachmentUploadState,
} from "../lib/composerAttachmentUploadQueue";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom } from "./server";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  modifyThreadOutboxMessage,
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

const recordQueuedAttachmentUpload = Effect.fn("ComposerAttachments.recordQueuedUpload")(function* (
  environmentId: EnvironmentId,
  uploaded: DraftComposerAttachment,
) {
  const editing = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  const holders = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).filter(
    (message) =>
      message.environmentId === environmentId &&
      !editing[message.messageId] &&
      withUploadedAttachment(message, uploaded) !== null,
  );
  yield* Effect.forEach(
    holders,
    (message) =>
      Effect.tryPromise({
        // An editor that opened meanwhile owns the message; its draft records the upload.
        try: () =>
          modifyThreadOutboxMessage(message.messageId, (current) =>
            appAtomRegistry.get(editingQueuedMessageIdsAtom)[current.messageId]
              ? null
              : withUploadedAttachment(current, uploaded),
          ),
        catch: uploadError,
      }),
    { concurrency: "unbounded", discard: true },
  );
});

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

/** Saves a finished upload's id on every draft and queued message holding the attachment. */
const recordComposerAttachmentUpload = Effect.fn("ComposerAttachments.recordUpload")(function* (
  request: ComposerAttachmentUploadRequest,
  uploadedId: string,
) {
  const { environmentId, attachment } = request;
  const uploaded: DraftComposerAttachment = {
    ...attachment,
    uploadedAttachmentId: uploadedId,
    uploadEnvironmentId: environmentId,
  };
  const queued = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  );
  const knownEnvironmentIds = appAtomRegistry
    .get(workspaceConnections.environmentsAtom)
    .map((environment) => environment.environmentId);
  let draftsChanged = false;
  for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
    if (
      composerDraftEnvironmentId(key, knownEnvironmentIds, queued, draft) === environmentId &&
      draft.attachments.some((candidate) => candidate.id === attachment.id)
    ) {
      draftsChanged = setComposerDraftAttachmentUpload(key, uploaded) || draftsChanged;
    }
  }
  yield* recordQueuedAttachmentUpload(environmentId, uploaded);
  if (!draftsChanged) return;
  // A failed draft save only costs a re-upload after restart; the outbox saves its own references.
  yield* Effect.tryPromise({ try: () => flushComposerDrafts(), catch: uploadError }).pipe(
    Effect.catchIf(
      (error) => isComposerDraftPersistenceError(error.cause),
      (error) =>
        Effect.logWarning(
          "[composer-attachments] could not save the uploaded reference",
          error.cause,
        ),
    ),
  );
});

function composerAttachmentUploads() {
  uploadQueue ??= createComposerAttachmentUploadQueue({
    onChange: (states) => appAtomRegistry.set(composerAttachmentUploadsAtom, states),
    upload: ({ environmentId, attachment }, signal, onProgress) => {
      const release = isFileBackedComposerAttachment(attachment)
        ? retainComposerAttachmentFileForPreview(attachment)
        : undefined;
      return uploadComposerAttachment(environmentId, attachment, signal, onProgress).finally(() =>
        release?.(),
      );
    },
    onUploaded: recordComposerAttachmentUpload,
  });
  return uploadQueue;
}

/** Every send uploads through here, so it joins the composer's upload of the same attachment. */
export function uploadComposerAttachmentShared(
  environmentId: EnvironmentId,
  attachment: DraftComposerAttachment,
) {
  return composerAttachmentUploads().upload({ environmentId, attachment });
}

/**
 * Uploads draft and queued attachments to their environment as soon as it is connected and
 * operable. The queue follows the requests atom for its whole lifetime.
 */
export function createComposerAttachmentUploadWorker(
  requestsAtom: Atom.Atom<
    ReadonlyArray<ComposerAttachmentUploadRequest>
  > = composerAttachmentUploadRequestsAtom,
) {
  ensureComposerDraftsLoaded();
  const queue = composerAttachmentUploads();
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
