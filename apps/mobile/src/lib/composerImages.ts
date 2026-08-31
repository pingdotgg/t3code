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
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import type { PickMultipleFilesResult } from "expo-file-system";
import { estimateBase64ByteSize } from "./base64";
import {
  COMPOSER_ATTACHMENT_DIRECTORY,
  resolveOwnedComposerAttachmentFileUri,
} from "./composerAttachmentFiles";
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

export interface DraftComposerFileAttachment {
  readonly id: string;
  readonly type: "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileUri: string;
  readonly uploadedAttachmentId?: string;
  readonly uploadEnvironmentId?: EnvironmentId;
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

/** Wire shape for startTurn: pure uploads without client draft id / previewUri. */
export function toUploadChatImageAttachments(
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): ReadonlyArray<UploadChatImageAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
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
            const chunk = reader.readBytes(
              Math.min(ATTACHMENT_COPY_CHUNK_BYTES, maxBytes - copiedBytes + 1),
            );
            if (chunk.byteLength === 0) {
              break;
            }
            copiedBytes += chunk.byteLength;
            if (copiedBytes > maxBytes) {
              throw new Error(fileAttachmentTooLargeMessage(name, maxBytes));
            }
            writer.writeBytes(chunk);
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
    // A failed copy can leave a partial destination file behind with no URI
    // returned to release it later; delete it before surfacing the failure.
    try {
      if (destination.exists) {
        destination.delete();
      }
    } catch (cleanupError) {
      console.warn("[composer-attachments] could not remove a partial copy", cleanupError);
    }
    throw error;
  }
  // An Android content: stream can deliver more bytes than the size it
  // reported before the copy. Validate the persisted copy so an oversized
  // file is never retained under a stale recorded size.
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
    if (ownedUri === null) {
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

async function createComposerFileAttachment(input: {
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
  readonly files: ReadonlyArray<DraftComposerFileAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      files: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
    };
  }

  const { File } = await import("expo-file-system");
  const endHandoff = beginForegroundHandoff();
  let result: PickMultipleFilesResult;
  try {
    result = await File.pickFileAsync({ multipleFiles: true });
  } finally {
    endHandoff();
  }
  if (result.canceled) {
    return { files: [], error: null };
  }

  const maxBytes = clampFileAttachmentUploadBytes(
    input.maxBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  );
  const attachments: DraftComposerFileAttachment[] = [];
  let error: string | null = null;
  let exceededAttachmentLimit = false;
  for (const file of result.result) {
    if (attachments.length >= remainingSlots) {
      exceededAttachmentLimit = true;
      break;
    }
    // A SAF/document picker can hand back a blank display name; the wire
    // contract rejects empty names at send time, so fall back before the name
    // reaches storage, errors, or the attachment itself.
    const name = file.name.trim().length > 0 ? file.name : "file";
    try {
      attachments.push(
        await createComposerFileAttachment({
          uri: file.uri,
          name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size ?? null,
          maxBytes,
        }),
      );
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

async function loadClipboard() {
  try {
    return await import("expo-clipboard");
  } catch (error) {
    throw new Error("Clipboard paste is unavailable right now.", { cause: error });
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

/** Videos use file uploads; omit maxVideoBytes for image-only destinations. */
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

  // The picker covers the Android activity, which reports the app as
  // backgrounded; the guard keeps background-triggered restarts away mid-pick.
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: input.maxVideoBytes === undefined ? ["images"] : ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      base64: true,
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
    if (!mimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${asset.fileName ?? "image"}'.`;
      continue;
    }
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
      error = `'${asset.fileName ?? "image"}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`;
      continue;
    }

    const base64 = asset.base64;
    if (!base64) {
      error = `Failed to read '${asset.fileName ?? "image"}'.`;
      continue;
    }

    const sizeBytes = asset.fileSize ?? estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${asset.fileName ?? "image"}' exceeds the 10 MB attachment limit.`;
      continue;
    }

    attachments.push({
      id: uuidv4(),
      type: "image",
      name: asset.fileName ?? "image",
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri: asset.uri,
    });
  }

  return {
    attachments,
    error,
  };
}

export async function pasteComposerClipboard(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly text: string | null;
  readonly error: string | null;
}> {
  let clipboard: Awaited<ReturnType<typeof loadClipboard>>;
  try {
    clipboard = await loadClipboard();
  } catch (error) {
    return {
      images: [],
      text: null,
      error: error instanceof Error ? error.message : "Clipboard paste is unavailable right now.",
    };
  }

  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;

  if (await clipboard.hasImageAsync()) {
    if (remainingSlots <= 0) {
      return {
        images: [],
        text: null,
        error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
      };
    }
    const image = await clipboard.getImageAsync({ format: "png" });
    if (!image) {
      return {
        images: [],
        text: null,
        error: "Clipboard image is unavailable.",
      };
    }

    const base64 = image.data.split(",")[1] ?? "";
    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return {
        images: [],
        text: null,
        error: "Clipboard image exceeds the 10 MB attachment limit.",
      };
    }

    return {
      images: [
        {
          id: uuidv4(),
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes,
          dataUrl: image.data,
          previewUri: image.data,
        },
      ],
      text: null,
      error: null,
    };
  }

  if (await clipboard.hasStringAsync()) {
    const text = await clipboard.getStringAsync();
    return {
      images: [],
      text: text.length > 0 ? text : null,
      error: text.length > 0 ? null : "Clipboard is empty.",
    };
  }

  return {
    images: [],
    text: null,
    error: "Clipboard does not contain pasteable text or image content.",
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

export function isOwnedPastedImageUri(uri: string): boolean {
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
      const base64 = await file.base64();
      const sizeBytes = estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        continue;
      }
      const mimeType = mimeTypeFromUri(uri);
      results.push({
        id: uuidv4(),
        type: "image",
        name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
        mimeType,
        sizeBytes,
        dataUrl: `data:${mimeType};base64,${base64}`,
        previewUri: ownedTemporaryFile ? `data:${mimeType};base64,${base64}` : uri,
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
