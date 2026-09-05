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
import type { DocumentPickerResult } from "expo-document-picker";
import { estimateBase64ByteSize } from "./base64";
import {
  COMPOSER_ATTACHMENT_DIRECTORY,
  isComposerAttachmentFileRetained,
  resolveOwnedComposerAttachmentFileUri,
} from "./composerAttachmentFiles";
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

export interface DraftComposerImageAttachment extends Omit<UploadChatImageAttachment, "dataUrl"> {
  readonly id: string;
  readonly previewUri: string;
  /** Owned image bytes for newly picked, pasted, and shared attachments. */
  readonly fileUri?: string;
  /** Inline image bytes stored by older builds. */
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
  readonly uploadedAttachmentId?: string;
  readonly uploadEnvironmentId?: EnvironmentId;
}

export type DraftComposerAttachment = DraftComposerImageAttachment | DraftComposerFileAttachment;

/** Any composer attachment whose bytes live in the app-owned attachment directory. */
export type FileBackedComposerAttachment = DraftComposerAttachment & { readonly fileUri: string };

/** Files and new images have local copies. Older images may still be inline. */
export function isFileBackedComposerAttachment(
  attachment: DraftComposerAttachment,
): attachment is FileBackedComposerAttachment {
  return attachment.fileUri !== undefined;
}

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";
const ATTACHMENT_COPY_CHUNK_BYTES = 64 * 1024;

function sanitizeComposerAttachmentFileName(name: string) {
  return (
    Array.from(name, (character) =>
      character === "/" || character === "\\" || character.charCodeAt(0) < 32 ? "-" : character,
    ).join("") || "file"
  );
}

export async function persistComposerAttachmentFile(
  uri: string,
  name: string,
  maxBytes?: number,
): Promise<string> {
  const { Directory, File, FileMode, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const safeName = sanitizeComposerAttachmentFileName(name);
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

/** Writes clipboard or picker JPEG bytes into the owned attachment directory. */
async function persistComposerImageBase64(base64: string, name: string): Promise<string> {
  if (estimateBase64ByteSize(base64) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error(fileAttachmentTooLargeMessage(name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES));
  }
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const destination = new File(
    directory,
    `${uuidv4()}-${sanitizeComposerAttachmentFileName(name)}`,
  );
  destination.create();
  try {
    await destination.write(base64, { encoding: "base64" });
  } catch (error) {
    // A failed write must not leave a partial copy no attachment will release.
    try {
      if (destination.exists) {
        destination.delete();
      }
    } catch (cleanupError) {
      console.warn("[composer-attachments] could not remove a partial write", cleanupError);
    }
    throw error;
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

/** Validates an already-owned image copy and builds its attachment; deletes the copy on failure. */
async function ownedComposerImageAttachment(input: {
  readonly fileUri: string;
  readonly name: string;
  readonly mimeType: string;
}): Promise<DraftComposerImageAttachment> {
  const { File } = await import("expo-file-system");
  try {
    const sizeBytes = new File(input.fileUri).size ?? 0;
    if (sizeBytes <= 0) {
      throw new Error(`'${input.name}' is empty or could not be read.`);
    }
    if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error(
        fileAttachmentTooLargeMessage(input.name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
      );
    }
    return {
      id: uuidv4(),
      type: "image",
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes,
      fileUri: input.fileUri,
      previewUri: input.fileUri,
    };
  } catch (error) {
    await removePersistedComposerAttachmentFile(input.fileUri);
    throw error;
  }
}

/** Copies a picked or pasted image into app-owned storage, validating the stored bytes. */
async function createComposerImageAttachment(input: {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
}): Promise<DraftComposerImageAttachment> {
  const fileUri = await persistComposerAttachmentFile(
    input.uri,
    input.name,
    PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  );
  return ownedComposerImageAttachment({ fileUri, name: input.name, mimeType: input.mimeType });
}

/** Reads only the file's magic number; picker exports can be many megabytes. */
async function hasJpegMagicBytes(uri: string): Promise<boolean> {
  try {
    const { File, FileMode } = await import("expo-file-system");
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      const bytes = handle.readBytes(3);
      return bytes.byteLength === 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    } finally {
      handle.close();
    }
  } catch {
    // An unreadable file surfaces as a copy failure later; trust the metadata.
    return false;
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

  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  let result: DocumentPickerResult;
  try {
    // File providers may expose a URI that FileSystem cannot read directly.
    // Import a readable cache copy before persisting the draft's owned file.
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
  const attachments: DraftComposerFileAttachment[] = [];
  let error: string | null = null;
  let exceededAttachmentLimit = false;
  for (const file of result.assets) {
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
          mimeType: file.mimeType || "application/octet-stream",
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
      shouldDownloadFromNetwork: true,
      // The picker's file copy keeps HEIC-family originals as HEIC on every
      // path, so its JPEG base64 export is the only supported-bytes source
      // for them. quality 1 keeps the fast original-file copy path; the
      // base64 string stays transient and is never persisted.
      base64: true,
      quality: 1,
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
    let mimeType = asset.mimeType?.toLowerCase();
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

    let name = asset.fileName?.trim() || "image";
    // The iOS picker can export JPEG bytes while its metadata still describes
    // the HEIC (or another) original. The file's magic number is the truth:
    // record JPEG when the picker silently transcoded.
    if (mimeType !== "image/jpeg" && (await hasJpegMagicBytes(asset.uri))) {
      mimeType = "image/jpeg";
      if (!/\.jpe?g$/i.test(name)) {
        name = `${name.replace(/\.[^.]+$/, "")}.jpg`;
      }
    }
    if (!mimeType || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
      // HEIC and friends: providers cannot accept the original bytes, so land
      // the picker's JPEG export in the owned directory instead of rejecting
      // the photo. iPhone camera-roll photos are HEIC by default. iOS always
      // exports JPEG; Android's quality-1 export is the raw original, so only
      // accept an export that actually carries the JPEG magic number ("/9j/"
      // is base64 for FF D8 FF).
      if (!asset.base64?.startsWith("/9j/")) {
        error = `'${name}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      const jpegName = /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "")}.jpg`;
      try {
        const jpegUri = await persistComposerImageBase64(asset.base64, jpegName);
        attachments.push(
          await ownedComposerImageAttachment({
            fileUri: jpegUri,
            name: jpegName,
            mimeType: "image/jpeg",
          }),
        );
      } catch (cause) {
        error = cause instanceof Error ? cause.message : `Failed to read '${name}'.`;
      }
      continue;
    }

    try {
      attachments.push(await createComposerImageAttachment({ uri: asset.uri, name, mimeType }));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `Failed to read '${name}'.`;
    }
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

    // The clipboard only yields inline bytes; land them in the owned
    // attachment directory once so drafts persist a path instead of megabytes.
    let fileUri: string;
    try {
      fileUri = await persistComposerImageBase64(base64, "pasted-image.png");
    } catch (cause) {
      return {
        images: [],
        text: null,
        error: cause instanceof Error ? cause.message : "Clipboard image could not be saved.",
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
          fileUri,
          previewUri: fileUri,
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
      const mimeType = mimeTypeFromUri(uri);
      results.push(
        await createComposerImageAttachment({
          uri,
          name: `pasted-image.${mimeType.split("/")[1] ?? "png"}`,
          mimeType,
        }),
      );
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
