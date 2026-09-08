import {
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
  type PersistedAttachmentVerification,
} from "@t3tools/client-runtime/state/attachments";
import { create } from "zustand";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";
import type { AttachmentUploadState, ReadyAttachmentUpload } from "./attachmentUploadState";

const MAX_UPLOADS_PER_ENVIRONMENT = 3;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

interface AttachmentUploadStore {
  readonly uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
}

export const useAttachmentUploadStore = create<AttachmentUploadStore>(() => ({
  uploadsByImageId: {},
}));

interface UploadJob {
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly environmentId: EnvironmentId;
  /**
   * The draft that owned this file when the job started. Completion resolves
   * the current owner because the file can move while the upload is pending.
   */
  readonly draftTarget?: ComposerThreadTarget;
  readonly previous?: ReadyAttachmentUpload;
  /**
   * The draft's persisted server-side upload, to verify instead of re-upload.
   * The draft owns this id; the queue never deletes it on cancel or retry.
   * Deleting it goes through `releasePersistedAttachmentUpload` only.
   */
  readonly persistedAttachmentId?: string;
  readonly settled: Promise<void>;
  resolveSettled: () => void;
  /** Only ids this queue minted itself. Cancel and retry may delete these. */
  attachmentId: string | null;
  cancelled: boolean;
  abort: (() => void) | null;
}

const jobsByImageId = new Map<string, UploadJob>();
const queue: UploadJob[] = [];
const activeUploadsByEnvironment = new Map<EnvironmentId, number>();

function setUploadState(imageId: string, upload: AttachmentUploadState): void {
  useAttachmentUploadStore.setState((state) => ({
    uploadsByImageId: { ...state.uploadsByImageId, [imageId]: upload },
  }));
}

function clearUploadState(imageId: string): void {
  useAttachmentUploadStore.setState((state) => {
    if (!(imageId in state.uploadsByImageId)) {
      return state;
    }
    const uploadsByImageId = { ...state.uploadsByImageId };
    delete uploadsByImageId[imageId];
    return { uploadsByImageId };
  });
}

export function readAttachmentUpload(imageId: string): AttachmentUploadState | undefined {
  return useAttachmentUploadStore.getState().uploadsByImageId[imageId];
}

/** Finds the file's current same-environment draft after any in-flight move. */
function resolveCurrentFileDraftTarget(job: UploadJob): ComposerThreadTarget | undefined {
  if (job.draftTarget === undefined || job.image.type !== "file") {
    return undefined;
  }
  const store = useComposerDraftStore.getState();
  for (const [key, draft] of Object.entries(store.draftsByThreadKey)) {
    if (!draft.files.some((file) => file.id === job.image.id)) {
      continue;
    }
    const draftSession = store.draftThreadsByThreadKey[key];
    if (draftSession !== undefined) {
      if (draftSession.environmentId === job.environmentId) {
        return DraftId.make(key);
      }
      continue;
    }
    // Tests and legacy callers can use a DraftId without session metadata.
    // Only its original job supplies enough environment identity to trust it.
    if (typeof job.draftTarget === "string" && job.draftTarget === key) {
      return DraftId.make(key);
    }
    const threadRef = parseScopedThreadKey(key);
    if (threadRef?.environmentId === job.environmentId) {
      return threadRef;
    }
  }
  return undefined;
}

/**
 * Persists a finished upload's ids onto the draft that owns the file. The
 * mounted composer effect performs the same write for live UI updates, but a
 * background completion (user navigated away, upload finished, reload) must
 * not depend on a mounted composer to survive. `setFileUpload` no-ops when
 * the draft row is gone or already carries these ids.
 */
function stampDraftFileUpload(job: UploadJob, attachmentId: string): void {
  const draftTarget = resolveCurrentFileDraftTarget(job);
  if (draftTarget === undefined) {
    return;
  }
  useComposerDraftStore
    .getState()
    .setFileUpload(draftTarget, job.image.id, job.environmentId, attachmentId);
}

function deletePendingUpload(environmentId: EnvironmentId, attachmentId: string): void {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId,
  });
}

function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload rejected (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}

async function runUpload(job: UploadJob): Promise<void> {
  if (job.persistedAttachmentId) {
    const verification = await verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId: job.environmentId,
      attachmentId: job.persistedAttachmentId,
    });
    if (job.cancelled) {
      return;
    }
    if (verification.status === "verified") {
      setUploadState(job.image.id, {
        status: "ready",
        environmentId: job.environmentId,
        attachmentId: job.persistedAttachmentId,
      });
      stampDraftFileUpload(job, job.persistedAttachmentId);
      return;
    }
    if (verification.status === "missing" && !job.image.file && job.image.type === "file") {
      const draftTarget = resolveCurrentFileDraftTarget(job);
      if (
        draftTarget !== undefined &&
        useComposerDraftStore
          .getState()
          .markFileUploadMissing(
            draftTarget,
            job.image.id,
            job.environmentId,
            job.persistedAttachmentId,
          )
      ) {
        clearUploadState(job.image.id);
        return;
      }
    }
    if (verification.status === "failed" || !job.image.file) {
      // No `attachmentId` here: a failed state's id marks a pending upload
      // this queue minted, which retry and release then delete. The persisted
      // id is the only server copy of a hydrated file, so a transient
      // verification failure must leave it in place for the next retry.
      setUploadState(job.image.id, {
        status: "failed",
        environmentId: job.environmentId,
        reason:
          verification.status === "missing"
            ? "Uploaded file expired. Remove it and attach it again."
            : "Uploaded file could not be verified. Retry when the server reconnects.",
        ...(job.previous ? { previous: job.previous } : {}),
      });
      return;
    }
  }

  const mimeType =
    job.image.type === "file"
      ? job.image.mimeType.toLowerCase()
      : PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
          (supportedMimeType) => supportedMimeType === job.image.mimeType.toLowerCase(),
        );
  if (!mimeType) {
    setUploadState(job.image.id, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Unsupported image type",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }
  const file = job.image.file;
  if (!file) {
    setUploadState(job.image.id, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Original file is no longer available",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }

  let lastStep = -1;
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId: job.environmentId,
    upload: {
      ...(job.image.type === "file" ? { type: "file" as const } : {}),
      name: job.image.name,
      mimeType,
      sizeBytes: file.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(job.environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) =>
      uploadBytes({
        url,
        file,
        mimeType,
        onProgress: (progress) => {
          const step = Math.floor(progress * 20);
          if (step === lastStep || job.cancelled) {
            return;
          }
          lastStep = step;
          setUploadState(job.image.id, {
            status: "uploading",
            environmentId: job.environmentId,
            progress,
            ...(job.previous ? { previous: job.previous } : {}),
          });
        },
      }),
    onMinted: (attachmentId) => {
      if (job.cancelled) {
        return "cancel";
      }
      job.attachmentId = attachmentId;
      return "continue";
    },
    onTransferStart: (abort) => {
      job.abort = abort;
    },
  });
  job.abort = null;
  if (result.status === "cancelled" || job.cancelled) {
    return;
  }
  if (result.status === "uploaded") {
    setUploadState(job.image.id, {
      status: "ready",
      environmentId: job.environmentId,
      attachmentId: result.attachmentId,
    });
    stampDraftFileUpload(job, result.attachmentId);
    if (job.previous) {
      deletePendingUpload(job.previous.environmentId, job.previous.attachmentId);
    }
    return;
  }
  setUploadState(job.image.id, {
    status: "failed",
    environmentId: job.environmentId,
    reason:
      result.step === "mint"
        ? "Upload could not start"
        : result.step === "resolve-url"
          ? "Not connected"
          : result.error instanceof Error
            ? result.error.message
            : "Upload failed",
    ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
    ...(job.previous ? { previous: job.previous } : {}),
  });
}

function pumpUploads(): void {
  for (let index = 0; index < queue.length;) {
    const job = queue[index]!;
    const active = activeUploadsByEnvironment.get(job.environmentId) ?? 0;
    if (active >= MAX_UPLOADS_PER_ENVIRONMENT) {
      index += 1;
      continue;
    }

    queue.splice(index, 1);
    if (job.cancelled) {
      continue;
    }
    activeUploadsByEnvironment.set(job.environmentId, active + 1);
    void runUpload(job)
      .catch(() => {
        if (!job.cancelled) {
          setUploadState(job.image.id, {
            status: "failed",
            environmentId: job.environmentId,
            reason: "Upload failed",
            ...(job.previous ? { previous: job.previous } : {}),
          });
        }
      })
      .finally(() => {
        if (jobsByImageId.get(job.image.id) === job) {
          jobsByImageId.delete(job.image.id);
        }
        const remaining = (activeUploadsByEnvironment.get(job.environmentId) ?? 1) - 1;
        if (remaining > 0) {
          activeUploadsByEnvironment.set(job.environmentId, remaining);
        } else {
          activeUploadsByEnvironment.delete(job.environmentId);
        }
        job.resolveSettled();
        pumpUploads();
      });
  }
}

export function startAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  /** Draft that owns the file; lets a background completion persist its ids. */
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  const existingJob = jobsByImageId.get(input.image.id);
  if (existingJob?.environmentId === input.environmentId) {
    return;
  }

  const existing = readAttachmentUpload(input.image.id);
  if (existing?.status === "ready" && existing.environmentId === input.environmentId) {
    return;
  }
  if (existing?.status === "failed" && existing.environmentId === input.environmentId) {
    return;
  }
  if (
    existing &&
    "previous" in existing &&
    existing.previous?.environmentId === input.environmentId
  ) {
    cancelAttachmentUpload(input.image.id);
    if (existing.status === "failed" && existing.attachmentId) {
      deletePendingUpload(existing.environmentId, existing.attachmentId);
    }
    setUploadState(input.image.id, existing.previous);
    return;
  }

  if (existingJob) {
    cancelAttachmentUpload(input.image.id);
  }
  const previous = existing?.status === "ready" ? existing : existing?.previous;
  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const job: UploadJob = {
    image: input.image,
    environmentId: input.environmentId,
    ...(input.draftTarget !== undefined ? { draftTarget: input.draftTarget } : {}),
    ...(previous ? { previous } : {}),
    ...(input.image.type === "file" &&
    input.image.uploadEnvironmentId === input.environmentId &&
    input.image.uploadedAttachmentId
      ? { persistedAttachmentId: input.image.uploadedAttachmentId }
      : {}),
    settled,
    resolveSettled,
    attachmentId: null,
    cancelled: false,
    abort: null,
  };

  jobsByImageId.set(input.image.id, job);
  queue.push(job);
  setUploadState(input.image.id, {
    status: "uploading",
    environmentId: input.environmentId,
    progress: 0,
    ...(previous ? { previous } : {}),
  });
  pumpUploads();
}

/**
 * Stops the job and deletes only the pending upload it minted itself. A
 * persisted draft upload survives cancellation (an environment switch cancels
 * the old job, and the draft still references that server copy).
 */
function cancelAttachmentUpload(imageId: string): void {
  const job = jobsByImageId.get(imageId);
  if (!job) {
    return;
  }
  job.cancelled = true;
  jobsByImageId.delete(imageId);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) {
    queue.splice(queuedIndex, 1);
  }
  job.abort?.();
  if (job.attachmentId) {
    deletePendingUpload(job.environmentId, job.attachmentId);
  }
  job.resolveSettled();
}

export function releaseAttachmentUpload(imageId: string): void {
  const upload = readAttachmentUpload(imageId);
  cancelAttachmentUpload(imageId);
  if (upload?.status === "ready") {
    deletePendingUpload(upload.environmentId, upload.attachmentId);
  } else if (upload) {
    if (upload.status === "failed" && upload.attachmentId) {
      deletePendingUpload(upload.environmentId, upload.attachmentId);
    }
    if (upload.previous) {
      deletePendingUpload(upload.previous.environmentId, upload.previous.attachmentId);
    }
  }
  clearUploadState(imageId);
}

export function releasePersistedAttachmentUpload(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): void {
  const upload = readAttachmentUpload(input.id);
  if (
    upload?.status === "ready" &&
    upload.environmentId === input.environmentId &&
    upload.attachmentId === input.attachmentId
  ) {
    releaseAttachmentUpload(input.id);
    return;
  }
  const job = jobsByImageId.get(input.id);
  if (
    job?.environmentId === input.environmentId &&
    job.persistedAttachmentId === input.attachmentId
  ) {
    // Tears down the in-flight verification or re-upload. The queue only
    // deletes ids it minted, so the persisted id still needs the delete below.
    releaseAttachmentUpload(input.id);
  }
  deletePendingUpload(input.environmentId, input.attachmentId);
}

export function retryAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  const previous = readAttachmentUpload(input.image.id);
  cancelAttachmentUpload(input.image.id);
  // A failed state's `attachmentId` is always one this queue minted, so this
  // never deletes a persisted draft upload. Retrying a hydrated file whose
  // verification failed leaves the server copy alone and verifies it again.
  if (previous?.status === "failed" && previous.attachmentId) {
    deletePendingUpload(previous.environmentId, previous.attachmentId);
  }
  if (previous && "previous" in previous && previous.previous) {
    setUploadState(input.image.id, previous.previous);
  } else {
    clearUploadState(input.image.id);
  }
  startAttachmentUpload(input);
}

/**
 * Checks that a stashed upload still exists on the server. Pending uploads
 * are swept after 24 hours, so a stash restore asks first instead of handing
 * the composer a dead reference.
 */
export function verifyStashedAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): Promise<PersistedAttachmentVerification> {
  return verifyPersistedAttachmentUpload({
    registry: appAtomRegistry,
    createAssetUrl: assetEnvironment.createUrl,
    environmentId: input.environmentId,
    attachmentId: input.attachmentId,
  });
}

export async function awaitAttachmentUploads(imageIds: ReadonlyArray<string>): Promise<void> {
  await Promise.all(imageIds.map((imageId) => jobsByImageId.get(imageId)?.settled));
}

export function getUploadedAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}): ChatAttachment[] | null {
  const attachments: ChatAttachment[] = [];
  for (const image of input.images) {
    const upload = readAttachmentUpload(image.id);
    if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) {
      return null;
    }
    attachments.push({
      type: image.type,
      id: upload.attachmentId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    });
  }
  return attachments;
}

/**
 * The one owner for discarding a draft attachment's server-side upload. The
 * queue-keyed release only sees in-memory state, so after a reload it finds
 * nothing and the pending upload leaks. When the draft carries a persisted
 * `uploadedAttachmentId` (which survives reloads), route through the persisted
 * release; it still prefers the queue path when the queue owns that same
 * attachment. Every draft discard path must funnel through here.
 */
export function releaseDraftAttachment(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
): void {
  if (
    attachment.type === "file" &&
    attachment.uploadedAttachmentId !== undefined &&
    attachment.uploadEnvironmentId !== undefined
  ) {
    releasePersistedAttachmentUpload({
      id: attachment.id,
      environmentId: attachment.uploadEnvironmentId,
      attachmentId: attachment.uploadedAttachmentId,
    });
    // A failed re-upload after verification can hold a newer minted
    // attachment under the queue key. Release whatever is left so neither
    // copy stays behind. (The pending delete is idempotent server-side.)
    if (jobsByImageId.has(attachment.id) || readAttachmentUpload(attachment.id)) {
      releaseAttachmentUpload(attachment.id);
    }
    return;
  }
  releaseAttachmentUpload(attachment.id);
}

export function releaseDraftAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): void {
  for (const attachment of attachments) {
    releaseDraftAttachment(attachment);
  }
}
