import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
  isAssetAttachmentNotFoundFailure,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  UploadChatImageAttachment,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession } from "../state/session";
import { retainComposerAttachmentFileForPreview } from "../state/use-composer-drafts";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
  type DraftComposerImageAttachment,
} from "./composerImages";
import { uuidv4 } from "./uuid";

/**
 * This module owns the server side of a composer attachment's lifecycle.
 * `prepareTurnAttachments` acquires pending uploads (verifying and reusing
 * persisted ones), hands the uploaded ids back to the attachment's durable
 * owner (queued outbox message or composer draft), and returns a release
 * handle for after the turn consumed the bytes. Nothing outside this module
 * mints or deletes pending uploads. The local-file side of the lifecycle is
 * owned by `removeThreadOutboxMessage` / the composer draft mutators, which
 * release files through `releaseUnusedComposerAttachmentFiles`.
 */
export type UploadedMobileAttachment =
  | UploadChatImageAttachment
  | ChatImageAttachment
  | ChatFileAttachment;

export function validateDraftFileAttachments(input: {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: {
        readonly attachmentUploads?: boolean;
        readonly fileAttachments?: { readonly maxUploadBytes: number };
      };
    };
  } | null;
}): string | null {
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  if (files.length === 0) return null;
  if (input.serverConfig === null) return "Server attachment support is still loading.";
  const capabilities = input.serverConfig.environment.capabilities;
  if (capabilities.attachmentUploads !== true || capabilities.fileAttachments === undefined) {
    return "This server does not support file attachments.";
  }
  const maxBytes = clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes);
  const oversized = files.find((attachment) => attachment.sizeBytes > maxBytes);
  return oversized ? fileAttachmentTooLargeMessage(oversized.name, maxBytes) : null;
}

/** Keep uploaded ids alongside the local bytes so a later send can reuse them. */
export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    if (
      !uploaded ||
      !("id" in uploaded) ||
      attachment.type !== uploaded.type ||
      (attachment.uploadedAttachmentId === uploaded.id &&
        attachment.uploadEnvironmentId === input.environmentId)
    ) {
      return attachment;
    }
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.id,
      uploadEnvironmentId: input.environmentId,
    };
  });
}

/**
 * Deletes pending uploads the client no longer references. Every delete result
 * is inspected; failed deletes are retried once and a persistent failure
 * throws, so a caller can never silently leak the outcome. (The server also
 * expires pending uploads, so a leaked id self-heals eventually.)
 */
export async function releasePendingAttachmentUploads(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  const deleteOnce = async (attachmentId: string): Promise<boolean> => {
    const result = await runAtomCommand(
      appAtomRegistry,
      attachmentEnvironment.remove,
      { environmentId, input: { attachmentId } },
      { reportFailure: false, reportDefect: false },
    );
    return (
      result._tag === "Success" ||
      isAssetAttachmentNotFoundFailure(squashAtomCommandFailure(result))
    );
  };

  const failedAttachmentIds: string[] = [];
  for (const attachmentId of attachmentIds) {
    if (!(await deleteOnce(attachmentId)) && !(await deleteOnce(attachmentId))) {
      failedAttachmentIds.push(attachmentId);
    }
  }
  if (failedAttachmentIds.length > 0) {
    throw new Error(
      `Could not delete ${failedAttachmentIds.length} pending attachment upload(s): ${failedAttachmentIds.join(", ")}.`,
    );
  }
}

async function releaseCreatedUploadsQuietly(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  try {
    await releasePendingAttachmentUploads(environmentId, attachmentIds);
  } catch (error) {
    // The original failure must propagate; the leaked pending uploads expire
    // on the server.
    console.warn("[attachments] could not delete abandoned pending uploads", error);
  }
}

export interface PreparedTurnAttachments {
  readonly status: "ready";
  /** Wire attachments for `startTurn`, in the original composer order. */
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  /** Composer attachments annotated with the uploaded pending ids. */
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  /** Every pending upload backing this turn (reused and newly minted). */
  readonly pendingAttachmentIds: ReadonlyArray<string>;
  /** Deletes all pending uploads once the delivered turn holds the bytes. */
  readonly releaseUploads: () => Promise<void>;
}

export type PrepareTurnAttachmentsResult =
  | PreparedTurnAttachments
  | { readonly status: "abandoned" };

function uploadedReference(
  attachment: DraftComposerAttachment,
  id: string,
): ChatImageAttachment | ChatFileAttachment {
  const fields = {
    id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  return attachment.type === "image" ? { type: "image", ...fields } : { type: "file", ...fields };
}

function attachmentUploadInput(attachment: DraftComposerAttachment) {
  const fields = {
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  if (attachment.type === "file") return { type: "file" as const, ...fields };
  const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
    (type) => type === attachment.mimeType.toLowerCase(),
  );
  if (!mimeType) throw new Error(`Unsupported image type for '${attachment.name}'.`);
  return { ...fields, mimeType };
}

/**
 * Wire shape for startTurn on servers without attachment uploads: pure inline
 * uploads without client draft id / previewUri. File-backed images read their
 * base64 from disk lazily, only when this legacy path is actually taken.
 */
async function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): Promise<ReadonlyArray<UploadChatImageAttachment>> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: await composerImageAttachmentDataUrl(attachment),
    })),
  );
}

/** Inline bytes for one image: legacy drafts carry them, file-backed ones read them from disk. */
async function composerImageAttachmentDataUrl(
  attachment: DraftComposerImageAttachment,
): Promise<string> {
  if (attachment.dataUrl !== undefined) {
    return attachment.dataUrl;
  }
  if (!isFileBackedComposerAttachment(attachment)) {
    throw new Error(`'${attachment.name}' is no longer available. Attach the image again.`);
  }
  const release = retainComposerAttachmentFileForPreview(attachment);
  try {
    const { File, Paths } = await import("expo-file-system");
    const uri =
      resolveOwnedComposerAttachmentFileUri(attachment.fileUri, Paths.document.uri) ??
      attachment.fileUri;
    const base64 = await new File(uri).base64();
    return `data:${attachment.mimeType};base64,${base64}`;
  } finally {
    release();
  }
}

async function uploadFileBytes(
  attachment: DraftComposerAttachment,
  url: string,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const { File, Paths, UploadType } = await import("expo-file-system");
  if (signal.aborted) throw new Error("Upload cancelled.");
  // Legacy image drafts persisted inline bytes and stage them in a temp cache
  // file for the native uploader. Everything else uploads its owned copy.
  const fileUri = attachment.fileUri;
  const inlineDataUrl = attachment.type === "image" ? attachment.dataUrl : undefined;
  if (fileUri === undefined && inlineDataUrl === undefined) {
    throw new Error(`'${attachment.name}' is no longer available. Attach the image again.`);
  }
  const file =
    fileUri === undefined
      ? new File(Paths.cache, `t3-upload-${uuidv4()}`)
      : new File(resolveOwnedComposerAttachmentFileUri(fileUri, Paths.document.uri) ?? fileUri);
  try {
    if (fileUri === undefined && inlineDataUrl !== undefined) {
      file.create();
      file.write(inlineDataUrl.slice(inlineDataUrl.indexOf(",") + 1), {
        encoding: "base64",
      });
    }
    const result = await file.upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": attachment.mimeType },
      signal,
      ...(onProgress
        ? {
            onProgress: ({ bytesSent, totalBytes }) => {
              if (totalBytes > 0) onProgress(bytesSent / totalBytes);
            },
          }
        : {}),
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Upload failed for '${attachment.name}' (${result.status}).`);
    }
  } finally {
    if (fileUri === undefined && file.exists) file.delete();
  }
}

/**
 * Acquires server-side uploads for one turn's attachments and persists the
 * uploaded ids into the attachments' durable owner.
 *
 * `persistUploadedReferences` runs once the bytes are on the server and only
 * when new ids appeared. It must write the annotated attachments into the
 * owner (queued message or draft) so a retry after a crash reuses the bytes.
 * Returning `"abandon"` (owner no longer wants the send) or throwing deletes
 * the pending uploads this call minted, so the owner cannot leak them.
 */
export async function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Older environments continue to receive inline images. */
  readonly supportsImageUploads?: boolean;
  readonly signal?: AbortSignal;
  readonly onUploadProgress?: (attachmentId: string, progress: number) => void;
  readonly persistUploadedReferences?: (
    draftAttachments: ReadonlyArray<DraftComposerAttachment>,
  ) => Promise<"persisted" | "abandon">;
}): Promise<PrepareTurnAttachmentsResult> {
  const { environmentId } = input;
  if (input.signal?.aborted) return { status: "abandoned" };
  const files = input.attachments.filter((attachment) => attachment.type === "file");
  const ready = (
    attachments: ReadonlyArray<UploadedMobileAttachment>,
    pendingAttachmentIds: ReadonlyArray<string>,
    draftAttachments: ReadonlyArray<DraftComposerAttachment>,
  ): PreparedTurnAttachments => ({
    status: "ready",
    attachments,
    draftAttachments,
    pendingAttachmentIds,
    releaseUploads: () => releasePendingAttachmentUploads(environmentId, pendingAttachmentIds),
  });

  if (input.attachments.length === 0 || (files.length === 0 && !input.supportsImageUploads)) {
    try {
      const imageAttachments = await toUploadChatImageAttachments(
        input.attachments.filter((attachment) => attachment.type === "image"),
      );
      if (input.signal?.aborted) return { status: "abandoned" };
      return ready(imageAttachments, [], input.attachments);
    } catch (error) {
      if (input.signal?.aborted) return { status: "abandoned" };
      throw error;
    }
  }

  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) {
    throw new Error("The environment is not connected.");
  }

  const uploadedAttachments: UploadedMobileAttachment[] = [];
  const pendingAttachmentIds: string[] = [];
  const createdAttachmentIds: string[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (const attachment of input.attachments) {
      if (controller.signal.aborted) throw new Error("Upload cancelled.");
      if (attachment.type === "image" && !input.supportsImageUploads) {
        uploadedAttachments.push(...(await toUploadChatImageAttachments([attachment])));
        continue;
      }

      // Reuse the bytes from a previous attempt when their pending upload is
      // still alive on this environment.
      if (
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId !== undefined
      ) {
        const verification = await verifyPersistedAttachmentUpload({
          registry: appAtomRegistry,
          createAssetUrl: assetEnvironment.createUrl,
          environmentId,
          attachmentId: attachment.uploadedAttachmentId,
        });
        if (verification.status === "failed") {
          throw verification.error;
        }
        if (verification.status === "verified") {
          pendingAttachmentIds.push(attachment.uploadedAttachmentId);
          uploadedAttachments.push(uploadedReference(attachment, attachment.uploadedAttachmentId));
          continue;
        }
        // "missing": the pending upload expired, upload the bytes again.
      }

      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload: attachmentUploadInput(attachment),
        // Read the connection at transfer time: the environment may have
        // reconnected on a new base URL since this cycle started.
        resolveUploadUrl: (relativeUrl) => {
          const currentConnection = appAtomRegistry.get(
            environmentSession.preparedConnectionValueAtom(environmentId),
          );
          return Option.isNone(currentConnection)
            ? null
            : resolveAssetUrl(currentConnection.value.httpBaseUrl, relativeUrl);
        },
        transport: (url) => ({
          done: uploadFileBytes(
            attachment,
            url,
            controller.signal,
            input.onUploadProgress
              ? (progress) => input.onUploadProgress?.(attachment.id, progress)
              : undefined,
          ),
          abort,
        }),
        onMinted: (attachmentId) => {
          if (controller.signal.aborted) return "cancel";
          pendingAttachmentIds.push(attachmentId);
          createdAttachmentIds.push(attachmentId);
          return "continue";
        },
      });
      if (result.status !== "uploaded") {
        throw result.status === "failed" && result.error !== undefined
          ? result.error
          : new Error(`Upload failed for '${attachment.name}'.`);
      }
      uploadedAttachments.push(uploadedReference(attachment, result.attachmentId));
    }

    if (controller.signal.aborted) throw new Error("Upload cancelled.");

    const draftAttachments = withUploadedMobileAttachmentReferences({
      environmentId,
      attachments: input.attachments,
      uploadedAttachments,
    });
    const referencesChanged = draftAttachments.some(
      (attachment, index) => attachment !== input.attachments[index],
    );
    if (referencesChanged && input.persistUploadedReferences) {
      if ((await input.persistUploadedReferences(draftAttachments)) === "abandon") {
        await releaseCreatedUploadsQuietly(environmentId, createdAttachmentIds);
        return { status: "abandoned" };
      }
    }
    return ready(uploadedAttachments, pendingAttachmentIds, draftAttachments);
  } catch (error) {
    await releaseCreatedUploadsQuietly(environmentId, createdAttachmentIds);
    if (controller.signal.aborted) return { status: "abandoned" };
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}
