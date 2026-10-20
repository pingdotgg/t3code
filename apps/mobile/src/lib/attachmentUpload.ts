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
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { resolveOwnedComposerAttachmentFileUri } from "./composerAttachmentFiles";
import { retainComposerAttachmentFileForPreview } from "./composerAttachmentPreviewRetention";
import {
  isComposerImageAttachment,
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
  type DraftComposerImageAttachment,
} from "./composerImages";
import { imageMimeType } from "@t3tools/shared/image";
import { uuidv4 } from "./uuid";

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

export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    // A picture picked through Files stays `type: "file"` in the draft while it uploads as an
    // image, so compare against the type it was actually sent under: comparing draft types
    // drops the id, and the next send re-uploads bytes the server already holds.
    const uploadedAs = isComposerImageAttachment(attachment) ? "image" : attachment.type;
    if (
      !uploaded ||
      !("id" in uploaded) ||
      uploadedAs !== uploaded.type ||
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

export async function releasePendingAttachmentUploads(
  environmentId: EnvironmentId,
  attachmentIds: ReadonlyArray<string>,
): Promise<void> {
  const deleteOnce = async (attachmentId: string): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot delete pending attachments.");
    }
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
    console.warn("[attachments] could not delete abandoned pending uploads", error);
  }
}

export interface PreparedTurnAttachments {
  readonly status: "ready";
  readonly attachments: ReadonlyArray<UploadedMobileAttachment>;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly pendingAttachmentIds: ReadonlyArray<string>;
}

export type PrepareTurnAttachmentsResult =
  | PreparedTurnAttachments
  | { readonly status: "abandoned" };

/**
 * A picture picked through Files arrives typed as a plain file, often with no usable mime, so it is
 * promoted to the type the provider accepts. Every place that names the attachment on the wire —
 * the upload header, the upload input, and the message reference — has to agree on this one value,
 * or the turn describes bytes that are not what was actually sent and `ChatImageAttachment` rejects
 * it.
 */
export function composerAttachmentWireMimeType(attachment: DraftComposerAttachment): string {
  if (!isComposerImageAttachment(attachment)) return attachment.mimeType;
  return supportedImageWireMimeType(attachment);
}

function supportedImageWireMimeType(
  attachment: DraftComposerAttachment,
): (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number] {
  const inferred = imageMimeType(attachment);
  const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
    (type) => type === attachment.mimeType.toLowerCase() || type === inferred,
  );
  if (!mimeType) throw new Error(`Unsupported image type for '${attachment.name}'.`);
  return mimeType;
}

function uploadedReference(
  attachment: DraftComposerAttachment,
  id: string,
): ChatImageAttachment | ChatFileAttachment {
  const fields = {
    id,
    name: attachment.name,
    mimeType: composerAttachmentWireMimeType(attachment),
    sizeBytes: attachment.sizeBytes,
  };
  return isComposerImageAttachment(attachment)
    ? { type: "image", ...fields }
    : {
        type: "file",
        ...fields,
        ...(attachment.source ? { source: attachment.source } : {}),
      };
}

function attachmentUploadInput(attachment: DraftComposerAttachment) {
  const fields = { name: attachment.name, sizeBytes: attachment.sizeBytes };
  return isComposerImageAttachment(attachment)
    ? { ...fields, mimeType: supportedImageWireMimeType(attachment) }
    : { type: "file" as const, ...fields, mimeType: attachment.mimeType };
}

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

// One stalled transfer must not hold every thread's serialized outbox.
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 180_000;

async function uploadFileBytes(
  environmentId: EnvironmentId,
  attachment: DraftComposerAttachment,
  url: string,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<void> {
  const { File, Paths, UploadType } = await import("expo-file-system");
  if (signal.aborted) throw new Error("Upload cancelled.");
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot upload attachments.");
  }
  const fileUri = attachment.fileUri;
  const inlineDataUrl = attachment.type === "image" ? attachment.dataUrl : undefined;
  if (fileUri === undefined && inlineDataUrl === undefined) {
    throw new Error(`'${attachment.name}' is no longer available. Attach the image again.`);
  }
  const file =
    fileUri === undefined
      ? new File(Paths.cache, `t3-upload-${uuidv4()}`)
      : new File(resolveOwnedComposerAttachmentFileUri(fileUri, Paths.document.uri) ?? fileUri);
  const transfer = new AbortController();
  const cancelTransfer = () => transfer.abort();
  signal.addEventListener("abort", cancelTransfer, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (fileUri === undefined && inlineDataUrl !== undefined) {
      file.create();
      await file.write(inlineDataUrl.slice(inlineDataUrl.indexOf(",") + 1), {
        encoding: "base64",
      });
    }
    if (signal.aborted) throw new Error("Upload cancelled.");
    const timedOut = Promise.withResolvers<never>();
    timer = setTimeout(() => {
      // Native cancellation can reject synchronously, so settle the timeout first.
      timedOut.reject(
        new Error(`'${attachment.name}' took too long to upload. Try a smaller file.`),
      );
      transfer.abort();
    }, ATTACHMENT_UPLOAD_TIMEOUT_MS);
    const upload = file.upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": composerAttachmentWireMimeType(attachment) },
      signal: transfer.signal,
      ...(onProgress
        ? {
            onProgress: ({ bytesSent, totalBytes }) => {
              if (!transfer.signal.aborted && totalBytes > 0) onProgress(bytesSent / totalBytes);
            },
          }
        : {}),
    });
    // Native cancellation may never settle the upload promise.
    const result = await Promise.race([upload, timedOut.promise]);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Upload failed for '${attachment.name}' (${result.status}).`);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancelTransfer);
    if (fileUri === undefined && file.exists) file.delete();
  }
}

/**
 * `persistUploadedReferences` runs once the bytes are on the server and only when new ids appeared.
 * It must write the annotated attachments into the owner (queued message or draft) so a retry after
 * a crash reuses the bytes.
 */
export async function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
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

  const requireUploadAccess = () => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      throw new Error("This connection cannot upload attachments.");
    }
  };
  requireUploadAccess();

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
      requireUploadAccess();
      if (attachment.type === "image" && !input.supportsImageUploads) {
        uploadedAttachments.push(...(await toUploadChatImageAttachments([attachment])));
        continue;
      }

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
      }

      requireUploadAccess();
      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload: attachmentUploadInput(attachment),
        // Read the connection at transfer time: the environment may have
        // reconnected on a new base URL since this cycle started.
        resolveUploadUrl: (relativeUrl) => {
          requireUploadAccess();
          const currentConnection = appAtomRegistry.get(
            environmentSession.preparedConnectionValueAtom(environmentId),
          );
          return Option.isNone(currentConnection)
            ? null
            : resolveAssetUrl(currentConnection.value.httpBaseUrl, relativeUrl);
        },
        transport: (url) => ({
          done: uploadFileBytes(
            environmentId,
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
