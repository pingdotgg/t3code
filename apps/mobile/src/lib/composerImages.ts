import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type PastedTextAttachmentSource,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import type { DocumentPickerResult } from "expo-document-picker";
import { estimateBase64ByteSize } from "./base64";
import {
  COMPOSER_ATTACHMENT_DIRECTORY,
  isComposerAttachmentFileRetained,
  resolveOwnedComposerAttachmentFileUri,
} from "./composerAttachmentFiles";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { fitComposerImage, renderPhoto } from "./composerImageFit";
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";
import { writeFileAtomically } from "./atomic-file";

export interface DraftComposerImageAttachment extends Omit<UploadChatImageAttachment, "dataUrl"> {
  readonly id: string;
  readonly previewUri: string;
  readonly fileUri?: string;
  readonly dataUrl?: string;
  readonly uploadedAttachmentId?: string;
  readonly uploadEnvironmentId?: EnvironmentId;
}

export interface DraftComposerFileAttachment {
  readonly id: string;
  readonly type: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileUri: string;
  readonly source?: PastedTextAttachmentSource;
  readonly uploadedAttachmentId?: string;
  readonly uploadEnvironmentId?: EnvironmentId;
}

export async function createPastedTextComposerAttachment(input: {
  readonly text: string;
  readonly name: string;
  readonly maxBytes: number;
}): Promise<DraftComposerFileAttachment> {
  const bytes = new TextEncoder().encode(input.text).byteLength;
  if (bytes <= 0) {
    throw new Error("Clipboard is empty.");
  }
  if (bytes > input.maxBytes) {
    throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes));
  }

  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${uuidv4()}-${input.name}`);
  await writeFileAtomically(file, input.text);
  return {
    id: uuidv4(),
    type: "file",
    name: input.name,
    mimeType: "text/plain;charset=utf-8",
    sizeBytes: bytes,
    fileUri: file.uri,
    source: { _tag: "pasted-text" },
  };
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

/** Non-media attachments require chip references; missing references mean lost draft files. */
export function composerStripAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<DraftComposerAttachment> {
  return attachments.filter(
    (attachment) =>
      attachment.type === "image" ||
      imageMimeType(attachment) !== null ||
      videoMimeType(attachment) !== null,
  );
}

/** Promote legacy document-picked images only when their originals fit the image contract. */
export function isComposerImageAttachment(
  attachment: DraftComposerAttachment,
): attachment is DraftComposerImageAttachment {
  return (
    attachment.type === "image" ||
    (attachment.sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES &&
      imageMimeType(attachment) !== null)
  );
}

export type FileBackedComposerAttachment = DraftComposerAttachment & { readonly fileUri: string };

export function isFileBackedComposerAttachment(
  attachment: DraftComposerAttachment,
): attachment is FileBackedComposerAttachment {
  return attachment.fileUri !== undefined;
}

/** Inline library/clipboard images own no file; local ids cannot resolve server assets. */
export function composerAttachmentInlineUri(
  attachment: DraftComposerAttachment | undefined,
): string | undefined {
  if (attachment === undefined || isFileBackedComposerAttachment(attachment)) return undefined;
  return attachment.type === "image" ? (attachment.dataUrl ?? attachment.previewUri) : undefined;
}

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";
const ATTACHMENT_COPY_CHUNK_BYTES = 64 * 1024;

export async function persistComposerAttachmentFile(
  uri: string,
  name: string,
  maxBytes?: number,
): Promise<string> {
  const { Directory, File, FileMode, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const safeName =
    Array.from(name, (character) =>
      character === "/" || character === "\\" || character.charCodeAt(0) < 32 ? "-" : character,
    ).join("") || "file";
  const destination = new File(directory, `${uuidv4()}-${safeName}`);
  const source = new File(uri);
  const sourceSize = source.size;
  if (
    maxBytes !== undefined &&
    (sourceSize === null || (sourceSize === 0 && uri.startsWith("content:")))
  ) {
    destination.create();
    try {
      const reader = source.open(FileMode.ReadOnly);
      try {
        const writer = destination.open(FileMode.WriteOnly);
        try {
          let copiedBytes = 0;
          while (true) {
            const chunk = await reader.readBytes(
              Math.min(ATTACHMENT_COPY_CHUNK_BYTES, maxBytes - copiedBytes + 1),
            );
            if (chunk.byteLength === 0) {
              break;
            }
            copiedBytes += chunk.byteLength;
            if (copiedBytes > maxBytes) {
              throw new Error(fileAttachmentTooLargeMessage(name, maxBytes));
            }
            await writer.writeBytes(chunk);
          }
        } finally {
          writer.close();
        }
      } finally {
        reader.close();
      }
    } catch (error) {
      if (destination.exists) {
        destination.delete();
      }
      throw error;
    }
    return destination.uri;
  }

  if (maxBytes !== undefined && sourceSize !== null && sourceSize > maxBytes) {
    throw new Error(fileAttachmentTooLargeMessage(name, maxBytes));
  }
  try {
    await source.copy(destination);
  } catch (error) {
    // Failed copies may leave untracked partial files; delete before surfacing failure.
    try {
      if (destination.exists) {
        destination.delete();
      }
    } catch (cleanupError) {
      console.warn("[composer-attachments] could not remove a partial copy", cleanupError);
    }
    throw error;
  }
  // Android content streams may exceed reported size; validate the persisted copy.
  const copiedSize = destination.size;
  if (maxBytes !== undefined && copiedSize !== null && copiedSize > maxBytes) {
    try {
      if (destination.exists) {
        destination.delete();
      }
    } catch (cleanupError) {
      console.warn("[composer-attachments] could not remove an oversized copy", cleanupError);
    }
    throw new Error(fileAttachmentTooLargeMessage(name, maxBytes));
  }
  return destination.uri;
}

export async function removePersistedComposerAttachmentFile(uri: string): Promise<void> {
  try {
    const { File, Paths } = await import("expo-file-system");
    const ownedUri = resolveOwnedComposerAttachmentFileUri(uri, Paths.document.uri);
    if (ownedUri === null || isComposerAttachmentFileRetained(ownedUri)) {
      return;
    }
    const file = new File(ownedUri);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    console.warn("[composer-attachments] could not remove local file", error);
  }
}

export async function createComposerFileAttachment(input: {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly maxBytes: number;
}): Promise<DraftComposerFileAttachment> {
  if (input.sizeBytes !== null && input.sizeBytes > input.maxBytes) {
    throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes));
  }
  const { File } = await import("expo-file-system");
  const fileUri = await persistComposerAttachmentFile(input.uri, input.name, input.maxBytes);
  try {
    const sizeBytes = new File(fileUri).size ?? input.sizeBytes ?? 0;
    if (sizeBytes <= 0) {
      throw new Error(`'${input.name}' is empty or could not be read.`);
    }
    if (sizeBytes > input.maxBytes) {
      throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes));
    }
    return {
      id: uuidv4(),
      type: "file",
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes,
      fileUri,
    };
  } catch (error) {
    await removePersistedComposerAttachmentFile(fileUri);
    throw error;
  }
}

export async function pickComposerFiles(input: {
  readonly existingCount: number;
  readonly maxBytes?: number;
}): Promise<{
  readonly files: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      files: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }

  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  let result: DocumentPickerResult;
  try {
    // Import a readable cache copy because FileSystem may not read provider URIs directly.
    result = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  } catch (cause) {
    return {
      files: [],
      error: cause instanceof Error ? cause.message : "Could not open the file picker.",
    };
  } finally {
    endHandoff();
  }
  if (result.canceled) {
    return { files: [], error: null };
  }

  const maxBytes = clampFileAttachmentUploadBytes(
    input.maxBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  );
  const attachments: DraftComposerAttachment[] = [];
  let error: string | null = null;
  let exceededAttachmentLimit = false;
  for (const file of result.assets) {
    if (attachments.length >= remainingSlots) {
      exceededAttachmentLimit = true;
      break;
    }
    // SAF can return blank display names, but the wire contract rejects them; fill before persisting.
    const name = file.name.trim().length > 0 ? file.name : "file";
    try {
      const mimeType = imageMimeType({ name, mimeType: file.mimeType ?? "" });
      const attachment = await createComposerFileAttachment({
        uri: file.uri,
        name,
        mimeType: file.mimeType || "application/octet-stream",
        sizeBytes: file.size ?? null,
        maxBytes:
          mimeType === null ? maxBytes : Math.max(maxBytes, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
      });
      if (mimeType === null || attachment.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        attachments.push(attachment);
        continue;
      }
      try {
        const { File } = await import("expo-file-system");
        const original = await new File(attachment.fileUri).base64();
        const candidate = await fitComposerImage({
          uri: attachment.fileUri,
          mimeType,
          base64: original,
        });
        const fitted =
          candidate !== null &&
          estimateBase64ByteSize(candidate.base64) <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            ? candidate
            : null;
        const base64 = fitted?.base64 ?? original;
        const sizeBytes = estimateBase64ByteSize(base64);
        if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          throw new Error(`'${name}' exceeds the 10 MB attachment limit.`);
        }
        const dataUrl = `data:${mimeType};base64,${base64}`;
        attachments.push({
          id: attachment.id,
          type: "image",
          name,
          mimeType,
          sizeBytes,
          dataUrl,
          previewUri: fitted?.uri ?? dataUrl,
        });
      } finally {
        await removePersistedComposerAttachmentFile(attachment.fileUri);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `Could not read '${name}'.`;
    }
  }
  if (exceededAttachmentLimit) {
    error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
  }
  return { files: attachments, error };
}

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("The photo library is unavailable right now.", { cause: error });
  }
}

export async function pickComposerImages(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  const result = await pickComposerMedia(input);
  return {
    images: result.attachments.filter((attachment) => attachment.type === "image"),
    error: result.error,
  };
}

export async function pickComposerMedia(input: {
  readonly existingCount: number;
  readonly maxVideoBytes?: number;
}): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      attachments: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      attachments: [],
      error: error instanceof Error ? error.message : "The photo library is unavailable right now.",
    };
  }

  // Android pickers report background state; guard against deferred restarts mid-pick.
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: input.maxVideoBytes === undefined ? ["images"] : ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      // Base64 makes iOS decode all full-size photos and stalls JS with large strings; read bytes only as needed.
      base64: false,
      quality: 1,
      shouldDownloadFromNetwork: true,
    });
  } catch (error) {
    return {
      attachments: [],
      error: error instanceof Error ? error.message : "Could not open the photo library.",
    };
  } finally {
    endHandoff();
  }

  if (result.canceled) {
    return {
      attachments: [],
      error: null,
    };
  }

  const attachments: DraftComposerAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    if (attachments.length >= remainingSlots) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`;
      break;
    }
    const mimeType = asset.mimeType?.toLowerCase();
    if (asset.type === "video" || mimeType?.startsWith("video/")) {
      if (input.maxVideoBytes === undefined) {
        error = "Video attachments are unavailable here.";
        continue;
      }
      try {
        const { File } = await import("expo-file-system");
        const file = new File(asset.uri);
        attachments.push(
          await createComposerFileAttachment({
            uri: asset.uri,
            name: asset.fileName?.trim() || file.name || "video",
            mimeType: mimeType || file.type || "application/octet-stream",
            sizeBytes: asset.fileSize ?? null,
            maxBytes: clampFileAttachmentUploadBytes(input.maxVideoBytes),
          }),
        );
      } catch (cause) {
        error =
          cause instanceof Error ? cause.message : `Could not read '${asset.fileName ?? "video"}'.`;
      }
      continue;
    }
    if (asset.type !== "image" && !mimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const name = asset.fileName?.trim() || "image";
    // Android content streams can exceed their reported size; measure the file before loading bytes into JS.
    let sourceBytes: number | null = null;
    try {
      const { File } = await import("expo-file-system");
      sourceBytes = new File(asset.uri).size;
    } catch {
      sourceBytes = null;
    }
    // Pass through supported, under-cap originals unchanged to preserve transparency and animation.
    const originalMimeType =
      mimeType !== undefined &&
      isProviderSendTurnSupportedImageMimeType(mimeType) &&
      sourceBytes !== null &&
      sourceBytes > 0 &&
      sourceBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ? mimeType
        : null;

    let image: { base64: string; mimeType: string; name: string; previewUri: string };
    try {
      if (originalMimeType !== null) {
        const { File } = await import("expo-file-system");
        const base64 = await new File(asset.uri).base64();
        const fitted = await fitComposerImage({
          uri: asset.uri,
          mimeType: originalMimeType,
          base64,
        });
        image = {
          base64: fitted?.base64 ?? base64,
          mimeType: originalMimeType,
          name,
          previewUri: fitted?.uri ?? asset.uri,
        };
      } else {
        const rendered = await renderPhoto(asset.uri);
        image = {
          base64: rendered.base64,
          mimeType: "image/jpeg",
          name: /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "")}.jpg`,
          previewUri: rendered.uri,
        };
      }
    } catch {
      error = `Failed to read '${name}'.`;
      continue;
    }

    const sizeBytes = estimateBase64ByteSize(image.base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${name}' exceeds the 10 MB attachment limit.`;
      continue;
    }

    attachments.push({
      id: uuidv4(),
      type: "image",
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes,
      dataUrl: `data:${image.mimeType};base64,${image.base64}`,
      previewUri: image.previewUri,
    });
  }

  return {
    attachments,
    error,
  };
}

function mimeTypeFromUri(uri: string): string {
  const ext = uri.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "image/png";
  }
}

function isOwnedPastedImageUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments.at(-2) === OWNED_PASTED_IMAGE_DIRECTORY && segments.at(-1)?.endsWith(".png") === true
    );
  } catch {
    return false;
  }
}

export async function convertPastedImagesToAttachments(input: {
  readonly uris: ReadonlyArray<string>;
  readonly existingCount: number;
}): Promise<ReadonlyArray<DraftComposerImageAttachment>> {
  const { File } = await import("expo-file-system");
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  const results: DraftComposerImageAttachment[] = [];

  for (const [index, uri] of input.uris.entries()) {
    const ownedTemporaryFile = isOwnedPastedImageUri(uri);
    try {
      if (index >= Math.max(0, remainingSlots)) {
        continue;
      }
      const file = new File(uri);
      const mimeType = mimeTypeFromUri(uri);
      const pastedBase64 = await file.base64();
      const fitted = await fitComposerImage({ uri, mimeType, base64: pastedBase64 });
      const base64 = fitted?.base64 ?? pastedBase64;
      const sizeBytes = estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      results.push({
        id: uuidv4(),
        type: "image",
        name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        sizeBytes,
        dataUrl: `data:${mimeType};base64,${base64}`,
        previewUri: ownedTemporaryFile ? `data:${mimeType};base64,${base64}` : (fitted?.uri ?? uri),
      });
    } catch (error) {
      console.warn("Failed to read pasted image", uri, error);
    } finally {
      if (ownedTemporaryFile) {
        try {
          const file = new File(uri);
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          console.warn("Failed to remove temporary pasted image", uri, error);
        }
      }
    }
  }

  return results;
}
