import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
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

export function withUploadedMobileAttachmentReferences(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment>;
}): ReadonlyArray<DraftComposerAttachment> {
  return input.attachments.map((attachment, index) => {
    const uploaded = input.uploadedAttachments[index];
    // Files-picked images upload as images; compare wire types to retain uploaded ids and avoid re-uploading.
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

/** Promote Files-picked images consistently in headers, payloads and references or ChatImageAttachment rejects them. */
function composerAttachmentWireMimeType(attachment: DraftComposerAttachment): string {
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
  try {
    if (fileUri === undefined && inlineDataUrl !== undefined) {
      file.create();
      await file.write(inlineDataUrl.slice(inlineDataUrl.indexOf(",") + 1), {
        encoding: "base64",
      });
    }
    const result = await file.upload(url, {
      httpMethod: "POST",
      uploadType: UploadType.BINARY_CONTENT,
      headers: { "Content-Type": composerAttachmentWireMimeType(attachment) },
      signal,
      ...(onProgress
        ? {
            // Native events carry Int64 counts, which expo-modules-jsi delivers as BigInt despite the `number` type.
            onProgress: ({ bytesSent, totalBytes }) => {
              const total = Number(totalBytes);
              if (total > 0) onProgress(Number(bytesSent) / total);
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

function requireUploadAccess(environmentId: EnvironmentId): void {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot upload attachments.");
  }
}

/**
 * Uploads one attachment and resolves to its uploaded id, reusing an earlier upload the server
 * still has. An abort deletes the pending upload it created.
 */
export async function uploadComposerAttachment(
  environmentId: EnvironmentId,
  attachment: DraftComposerAttachment,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<string> {
  requireUploadAccess(environmentId);
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
    if (verification.status === "failed") throw verification.error;
    if (verification.status === "verified") return attachment.uploadedAttachmentId;
  }
  if (signal.aborted) throw new Error("Upload cancelled.");
  requireUploadAccess(environmentId);
  if (
    Option.isNone(
      appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
    )
  ) {
    throw new Error("The environment is not connected.");
  }
  let minted: string | null = null;
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: attachmentUploadInput(attachment),
    // Resolve at transfer time; reconnects may change the base URL.
    resolveUploadUrl: (relativeUrl) => {
      requireUploadAccess(environmentId);
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      return Option.isNone(connection)
        ? null
        : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
    },
    transport: (url) => ({
      done: uploadFileBytes(environmentId, attachment, url, signal, onProgress),
      abort: () => {},
    }),
    onMinted: (attachmentId) => {
      if (signal.aborted) return "cancel";
      minted = attachmentId;
      return "continue";
    },
  });
  if (result.status === "uploaded") return result.attachmentId;
  if (minted !== null) await releaseCreatedUploadsQuietly(environmentId, [minted]);
  throw result.status === "failed" && result.error !== undefined
    ? result.error
    : new Error(`Upload failed for '${attachment.name}'.`);
}

/**
 * Turns a message's attachments into wire references. `uploadAttachment` is the shared upload
 * registry, so a send joins an upload the composer already started. persistUploadedReferences
 * runs only for new uploaded ids; save them to their owner so crash retries reuse bytes.
 */
export async function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly supportsImageUploads?: boolean;
  readonly signal?: AbortSignal;
  readonly uploadAttachment: (attachment: DraftComposerAttachment) => Promise<string>;
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

  requireUploadAccess(environmentId);
  const uploadedAttachments: UploadedMobileAttachment[] = [];
  const pendingAttachmentIds: string[] = [];
  try {
    for (const attachment of input.attachments) {
      if (input.signal?.aborted) return { status: "abandoned" };
      if (attachment.type === "image" && !input.supportsImageUploads) {
        uploadedAttachments.push(...(await toUploadChatImageAttachments([attachment])));
        continue;
      }
      const uploadedId = await input.uploadAttachment(attachment);
      pendingAttachmentIds.push(uploadedId);
      uploadedAttachments.push(uploadedReference(attachment, uploadedId));
    }
  } catch (error) {
    if (input.signal?.aborted) return { status: "abandoned" };
    throw error;
  }
  if (input.signal?.aborted) return { status: "abandoned" };

  const draftAttachments = withUploadedMobileAttachmentReferences({
    environmentId,
    attachments: input.attachments,
    uploadedAttachments,
  });
  const referencesChanged = draftAttachments.some(
    (attachment, index) => attachment !== input.attachments[index],
  );
  if (
    referencesChanged &&
    input.persistUploadedReferences &&
    (await input.persistUploadedReferences(draftAttachments)) === "abandon"
  ) {
    return { status: "abandoned" };
  }
  return ready(uploadedAttachments, pendingAttachmentIds, draftAttachments);
}
