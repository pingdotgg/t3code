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
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";
import { writeFileAtomically } from "./atomic-file";

export interface DraftComposerImageAttachment extends Omit<UploadChatImageAttachment, "dataUrl"> {
  readonly id: string;
  readonly previewUri: string;
  /** Owned image bytes from a file-backed draft. Current writers still use inline bytes. */
  readonly fileUri?: string;
  /** Inline bytes from current writers and older drafts. */
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

/**
 * What the strip above the composer shows: media, and nothing else. A thumbnail is the only
 * way to see a picture or a video, so those always preview there. Everything else reads as
 * its inline chip, which carries the name, the type and the size in the line of prose the
 * file belongs to — a square tile showing a generic document glyph says strictly less.
 *
 * The chip is not optional for a non-media file. Every path that attaches one also writes
 * its reference, so a file with no chip means the draft lost it rather than that the strip
 * should stand in. Which attachments carry a chip is therefore not consulted at all; surfaces
 * whose attachments never get chips (a question answer) pass them to the strip directly
 * instead of through this filter.
 */
export function composerStripAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): ReadonlyArray<DraftComposerAttachment> {
  return attachments.filter(
    (attachment) => isComposerImageAttachment(attachment) || videoMimeType(attachment) !== null,
  );
}

/**
 * Whether a draft attachment is a picture. The document picker types every pick as a plain
 * file, so the answer comes from the attachment itself rather than from which picker made it.
 */
export function isComposerImageAttachment(
  attachment: DraftComposerAttachment,
): attachment is DraftComposerImageAttachment {
  return attachment.type === "image" || imageMimeType(attachment) !== null;
}

/** Any composer attachment whose bytes live in the app-owned attachment directory. */
export type FileBackedComposerAttachment = DraftComposerAttachment & { readonly fileUri: string };

/** Files have a local copy. Images can have one after a file-backed draft is restored. */
export function isFileBackedComposerAttachment(
  attachment: DraftComposerAttachment,
): attachment is FileBackedComposerAttachment {
  return attachment.fileUri !== undefined;
}

/**
 * The bytes a draft attachment can be previewed from without the server. A picture taken from
 * the photo library or the clipboard owns no file and carries its bytes inline, and its
 * `attachmentId` is a local draft id the server has never seen — so falling back to a remote
 * asset for one only ever fails. Returns undefined when the attachment really is remote-only.
 */
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

/**
 * Longest edge kept when a photo has to be re-encoded. Matches the web composer's
 * MAX_DIMENSION so every client hands providers the same resolution.
 */
const PHOTO_MAX_EDGE = 2048;
const PHOTO_JPEG_QUALITY = 0.85;

/**
 * Renders a photo-library pick to a provider-readable JPEG. Decode, downscale, and encode run
 * natively; only the bounded result crosses the bridge. Camera photos are 12-48 MP HEIC files,
 * so a full-size conversion is both slow to transfer and far more than a model can use.
 */
async function renderPhotoAsJpeg(uri: string): Promise<{ base64: string; uri: string }> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const longestEdge = Math.max(image.width, image.height);
    if (longestEdge > PHOTO_MAX_EDGE) {
      const resized = await ImageManipulator.manipulate(image)
        .resize(
          image.width >= image.height ? { width: PHOTO_MAX_EDGE } : { height: PHOTO_MAX_EDGE },
        )
        .renderAsync();
      image.release();
      image = resized;
    }
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: PHOTO_JPEG_QUALITY,
      base64: true,
    });
    if (!saved.base64) {
      throw new Error("The rendered photo has no bytes.");
    }
    return { base64: saved.base64, uri: saved.uri };
  } finally {
    image.release();
  }
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
      // Bytes stay in the picker's file until we know how much of them we need. Asking for
      // base64 here made iOS decode and re-encode every camera photo at full resolution and
      // hand JS a 10 MB+ string, which stalled the composer for seconds.
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
    // The picker's reported size is a hint, not a measurement: Android content streams can
    // deliver more bytes than they advertise. Only a size read from the file itself decides
    // whether the original bytes are safe to load into JS.
    let sourceBytes: number | null = null;
    try {
      const { File } = await import("expo-file-system");
      sourceBytes = new File(asset.uri).size;
    } catch {
      sourceBytes = null;
    }
    // Originals the provider can read and that fit the cap pass through byte for byte so
    // transparency and animation survive. Everything else (HEIC/HEIF, oversized JPEGs,
    // unmeasurable sources) is rendered to a bounded JPEG off the JS thread.
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
        image = {
          base64: await new File(asset.uri).base64(),
          mimeType: originalMimeType,
          name,
          previewUri: asset.uri,
        };
      } else {
        const rendered = await renderPhotoAsJpeg(asset.uri);
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

/** Clipboard images take priority over their alternate text representation. */
export async function pasteComposerClipboard(input: { readonly existingCount: number }): Promise<
  | {
      readonly images: ReadonlyArray<DraftComposerImageAttachment>;
      readonly text: null;
      readonly error: string | null;
    }
  | {
      readonly images: readonly [];
      readonly text: string;
      readonly error: null;
    }
> {
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
      ...(text.length > 0 ? { text, error: null } : { text: null, error: "Clipboard is empty." }),
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
