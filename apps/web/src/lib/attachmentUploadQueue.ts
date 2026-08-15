/**
 * Upload-on-attach queue for composer image attachments.
 *
 * Each attached image walks: mint a signed upload URL over ws (with the exact
 * post-compression byte count) -> POST the raw bytes to that URL over HTTP ->
 * mark the chip ready. XHR rather than fetch, because the chip needs
 * `upload.onprogress` and the user needs `abort()`.
 *
 * Lives outside React so an upload survives a thread switch, a composer
 * remount, or the panel that started it being unmounted mid-flight.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import {
  type ComposerImageAttachment,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  type ComposerAttachmentUpload,
  MAX_CONCURRENT_ATTACHMENT_UPLOADS,
} from "./attachmentUploadState";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";

interface UploadJob {
  readonly imageId: string;
  /** Mutable: a draft move retargets live jobs (`retargetAttachmentUploads`). */
  target: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  /**
   * A prior copy of the same image in another environment, deleted only once
   * this upload succeeds. Deleting it up front would leave zero server copies
   * if the re-upload fails.
   */
  readonly supersedes: {
    readonly environmentId: EnvironmentId;
    readonly attachmentId: string;
  } | null;
  readonly file: File;
  readonly name: string;
  readonly mimeType: string;
  /** Resolves with the terminal upload state once the job stops running. */
  readonly settled: Promise<ComposerAttachmentUpload | null>;
  resolveSettled: (upload: ComposerAttachmentUpload | null) => void;
  finalUpload: ComposerAttachmentUpload | null;
  /** Set once the URL has been minted, so a cancel can release the reservation. */
  attachmentId: string | null;
  cancelled: boolean;
  abort: (() => void) | null;
}

const jobsByImageId = new Map<string, UploadJob>();
/**
 * Terminal states of finished jobs, kept after the job itself is discarded.
 * `awaitAttachmentUploads` reads through this so an upload that completed
 * before the await started is still reported instead of silently dropped.
 * Entries die on cancel/release; the map is bounded by images attached in a
 * session.
 */
const settledUploadsByImageId = new Map<string, ComposerAttachmentUpload>();
const queue: UploadJob[] = [];
let activeCount = 0;

function setUploadState(job: UploadJob, upload: ComposerAttachmentUpload): void {
  if (job.cancelled) return;
  job.finalUpload = upload;
  useComposerDraftStore.getState().setImageUpload(job.target, job.imageId, upload);
}

function finishJob(job: UploadJob): void {
  if (jobsByImageId.get(job.imageId) === job) {
    jobsByImageId.delete(job.imageId);
    if (job.finalUpload !== null) {
      settledUploadsByImageId.set(job.imageId, job.finalUpload);
    }
  }
  job.resolveSettled(job.finalUpload);
}

/** Best-effort release of server-side bytes. Failures are not worth surfacing. */
function deleteAttachment(environmentId: EnvironmentId, attachmentId: string): void {
  void runAtomCommand(
    appAtomRegistry,
    attachmentEnvironment.remove,
    { environmentId, input: { attachmentId } },
    { reportFailure: false, reportDefect: false },
  );
}

interface ByteUpload {
  readonly done: Promise<"ok" | "aborted">;
  readonly abort: () => void;
}

/**
 * Hard ceiling on one upload attempt. Compressed images are a few MB at most,
 * so five minutes only ever triggers on a genuinely stalled connection —
 * without it a stalled POST never settles, the chip stays `uploading`, and
 * everything gated on settlement (send, pick-and-send) hangs with it.
 */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

function postBytes(
  url: string,
  file: File,
  mimeType: string,
  onProgress: (progress: number) => void,
): ByteUpload {
  const xhr = new XMLHttpRequest();
  const done = new Promise<"ok" | "aborted">((resolve, reject) => {
    xhr.open("POST", url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve("ok");
        return;
      }
      reject(new Error(`Upload rejected (${xhr.status})`));
    });
    xhr.addEventListener("abort", () => resolve("aborted"));
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

async function runJob(job: UploadJob): Promise<void> {
  const minted = await runAtomCommand(
    appAtomRegistry,
    attachmentEnvironment.createUploadUrl,
    {
      environmentId: job.environmentId,
      input: { name: job.name, mimeType: job.mimeType, sizeBytes: job.file.size },
    },
    { reportFailure: false },
  );
  if (job.cancelled) return;
  if (minted._tag !== "Success") {
    setUploadState(job, { status: "failed", reason: "Upload could not start" });
    return;
  }
  job.attachmentId = minted.value.attachmentId;

  const connection = readPreparedConnection(job.environmentId);
  const uploadUrl = connection
    ? resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl)
    : null;
  if (uploadUrl === null) {
    setUploadState(job, { status: "failed", reason: "Not connected" });
    return;
  }

  // Whole-percent updates only: the raw progress event fires far more often
  // than the chip has anything new to say, and every update is a store write.
  let lastPercent = -1;
  const byteUpload = postBytes(uploadUrl, job.file, job.mimeType, (progress) => {
    const percent = Math.floor(progress * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    setUploadState(job, { status: "uploading", progress });
  });
  job.abort = byteUpload.abort;

  try {
    const outcome = await byteUpload.done;
    if (job.cancelled || outcome === "aborted") return;
    setUploadState(job, {
      status: "ready",
      attachmentId: minted.value.attachmentId,
      environmentId: job.environmentId,
    });
    if (job.supersedes) {
      deleteAttachment(job.supersedes.environmentId, job.supersedes.attachmentId);
    }
  } catch (error) {
    if (job.cancelled) return;
    setUploadState(job, {
      status: "failed",
      reason: error instanceof Error ? error.message : "Upload failed",
    });
  } finally {
    job.abort = null;
  }
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT_ATTACHMENT_UPLOADS && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.cancelled) continue;
    activeCount += 1;
    void runJob(job)
      .catch(() => {
        setUploadState(job, { status: "failed", reason: "Upload failed" });
      })
      .finally(() => {
        activeCount -= 1;
        finishJob(job);
        pump();
      });
  }
}

/**
 * Queues an image for upload and marks its chip `uploading`. Safe to call for
 * an image that is already queued or in flight: the existing job wins.
 */
export function startAttachmentUpload(input: {
  target: ComposerThreadTarget;
  environmentId: EnvironmentId;
  image: ComposerImageAttachment;
  /** See UploadJob.supersedes — set when re-uploading across environments. */
  supersedes?: { readonly environmentId: EnvironmentId; readonly attachmentId: string };
}): void {
  const { image } = input;
  if (!image.file || jobsByImageId.has(image.id)) {
    return;
  }
  let resolveSettled: (upload: ComposerAttachmentUpload | null) => void = () => {};
  const settled = new Promise<ComposerAttachmentUpload | null>((resolve) => {
    resolveSettled = resolve;
  });
  const job: UploadJob = {
    imageId: image.id,
    target: input.target,
    environmentId: input.environmentId,
    supersedes: input.supersedes ?? null,
    file: image.file,
    name: image.name,
    mimeType: image.mimeType,
    settled,
    resolveSettled,
    finalUpload: null,
    attachmentId: null,
    cancelled: false,
    abort: null,
  };
  jobsByImageId.set(image.id, job);
  queue.push(job);
  setUploadState(job, { status: "uploading", progress: 0 });
  pump();
}

/**
 * Aborts an in-flight upload and releases anything already reserved for it.
 * Used by chip removal and by the retry path before it re-queues.
 */
export function cancelAttachmentUpload(imageId: string): void {
  settledUploadsByImageId.delete(imageId);
  const job = jobsByImageId.get(imageId);
  if (!job) return;
  job.cancelled = true;
  jobsByImageId.delete(imageId);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex >= 0) {
    queue.splice(queuedIndex, 1);
  }
  job.abort?.();
  if (job.attachmentId) {
    deleteAttachment(job.environmentId, job.attachmentId);
  }
  job.resolveSettled(null);
}

/**
 * Drops an image from the composer's point of view: cancels an in-flight
 * upload, and releases the server copy when the upload already landed.
 */
export function releaseComposerAttachment(image: ComposerImageAttachment): void {
  cancelAttachmentUpload(image.id);
  if (image.upload.status === "ready") {
    deleteAttachment(image.upload.environmentId, image.upload.attachmentId);
  }
}

/**
 * Points in-flight uploads at a new composer target after
 * `moveComposerPromptAndImages`. Without this, progress and completion writes
 * keep landing on the source draft and the moved chip never leaves
 * `uploading`.
 */
export function retargetAttachmentUploads(
  imageIds: ReadonlyArray<string>,
  target: ComposerThreadTarget,
): void {
  for (const imageId of imageIds) {
    const job = jobsByImageId.get(imageId);
    if (job) {
      job.target = target;
    }
  }
}

/** Re-runs a failed (or environment-stale) upload with the File still in memory. */
export function retryAttachmentUpload(input: {
  target: ComposerThreadTarget;
  environmentId: EnvironmentId;
  image: ComposerImageAttachment;
}): void {
  cancelAttachmentUpload(input.image.id);
  startAttachmentUpload(input);
}

/**
 * Resolves once every listed image has settled, keyed by image id. The send
 * button is disabled while uploads run, but the preview-annotation "pick and
 * send" path attaches and sends in one gesture, so it has to wait here — and
 * it needs the settled states, because the draft it read them from is already
 * cleared by then.
 */
export async function awaitAttachmentUploads(
  imageIds: ReadonlyArray<string>,
): Promise<Map<string, ComposerAttachmentUpload>> {
  const results = new Map<string, ComposerAttachmentUpload>();
  const pending: Array<Promise<readonly [string, ComposerAttachmentUpload | null]>> = [];
  for (const imageId of imageIds) {
    const job = jobsByImageId.get(imageId);
    if (job) {
      pending.push(job.settled.then((upload) => [imageId, upload] as const));
      continue;
    }
    // The job may have settled (and been discarded) before this await began.
    const settledUpload = settledUploadsByImageId.get(imageId);
    if (settledUpload) {
      results.set(imageId, settledUpload);
    }
  }
  for (const [imageId, upload] of await Promise.all(pending)) {
    if (upload) {
      results.set(imageId, upload);
    }
  }
  return results;
}
