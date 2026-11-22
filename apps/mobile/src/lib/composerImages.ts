import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type PastedTextAttachmentSource,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import type { AttachmentUploadStatus } from "@t3tools/client-runtime/state/attachment-uploads";
import type { DocumentPickerResult } from "expo-document-picker";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
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
    throw new Error(m(msg("Clipboard is empty.")));
  }
  if (bytes > input.maxBytes) {
    throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes, m));
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
 * Non-media attachments require chip references; missing references mean lost draft files.
 * A chip cannot retry an upload or show its progress, so a document whose upload failed joins
 * the strip until its retry finishes.
 */
export function composerStripAttachments(
  attachments: ReadonlyArray<DraftComposerAttachment>,
  uploadStatus: (attachment: DraftComposerAttachment) => AttachmentUploadStatus | undefined,
): ReadonlyArray<DraftComposerAttachment> {
  return attachments.filter((attachment) => {
    if (
      attachment.type === "image" ||
      imageMimeType(attachment) !== null ||
      videoMimeType(attachment) !== null
    ) {
      return true;
    }
    const upload = uploadStatus(attachment);
    return (
      upload?.status === "failed" || (upload?.status === "uploading" && upload.retrying === true)
    );
  });
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

/** Legacy inline images have only a local draft id, so a remote asset lookup cannot load them. */
export function composerAttachmentInlineUri(
  attachment: DraftComposerAttachment | undefined,
): string | undefined {
  if (attachment === undefined || isFileBackedComposerAttachment(attachment)) return undefined;
  return attachment.type === "image" ? (attachment.dataUrl ?? attachment.previewUri) : undefined;
}

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";
const ATTACHMENT_COPY_CHUNK_BYTES = 64 * 1024;

// Android's java.net.URI rejects characters expo-file-system leaves unencoded, such as `[` and `]`.
function safeComposerAttachmentName(name: string): string {
  return name.replace(/[^\w. -]/g, "-") || "file";
}

export async function persistComposerAttachmentFile(
  uri: string,
  name: string,
  maxBytes?: number,
): Promise<string> {
  const { Directory, File, FileMode, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_ATTACHMENT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const prefix = `${uuidv4()}-`;
  // The basename is ASCII. Keep its tail for the extension within the 255-byte filesystem limit.
  const nameBudget = 255 - prefix.length;
  const destination = new File(
    directory,
    prefix + safeComposerAttachmentName(name).slice(-nameBudget),
  );
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
              throw new Error(fileAttachmentTooLargeMessage(name, maxBytes, m));
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
    throw new Error(fileAttachmentTooLargeMessage(name, maxBytes, m));
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
    throw new Error(fileAttachmentTooLargeMessage(name, maxBytes, m));
  }
  return destination.uri;
}

async function ownedComposerImageAttachment(input: {
  readonly fileUri: string;
  readonly name: string;
  readonly mimeType: string;
}): Promise<DraftComposerImageAttachment> {
  try {
    const { File } = await import("expo-file-system");
    const sizeBytes = new File(input.fileUri).size;
    if (sizeBytes === null || sizeBytes <= 0) {
      throw new Error(m(msg("''{name}'' is empty or could not be read.", { name: input.name })));
    }
    if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error(
        fileAttachmentTooLargeMessage(input.name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES, m),
      );
    }
    return {
      ...input,
      id: uuidv4(),
      type: "image",
      sizeBytes,
      previewUri: input.fileUri,
    };
  } catch (error) {
    await removePersistedComposerAttachmentFile(input.fileUri);
    throw error;
  }
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
    throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes, m));
  }
  const { File } = await import("expo-file-system");
  const fileUri = await persistComposerAttachmentFile(input.uri, input.name, input.maxBytes);
  try {
    const sizeBytes = new File(fileUri).size ?? input.sizeBytes ?? 0;
    if (sizeBytes <= 0) {
      throw new Error(m(msg("''{name}'' is empty or could not be read.", { name: input.name })));
    }
    if (sizeBytes > input.maxBytes) {
      throw new Error(fileAttachmentTooLargeMessage(input.name, input.maxBytes, m));
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
  readonly acceptSelection?: () => boolean;
}): Promise<{
  readonly files: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      files: [],
      error: m(
        msg("You can attach up to {max} files per message.", {
          max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        }),
      ),
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
      error: errorDisplayMessage(cause, m) ?? m(msg("Could not open the file picker.")),
    };
  } finally {
    endHandoff();
  }
  if (result.canceled || input.acceptSelection?.() === false) {
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
      const { File } = await import("expo-file-system");
      let fileUri = attachment.fileUri;
      try {
        const original = await new File(fileUri).base64();
        const candidate = await fitComposerImage({ uri: fileUri, mimeType, base64: original });
        const fitted =
          candidate !== null &&
          estimateBase64ByteSize(candidate.base64) <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            ? candidate
            : null;
        if (fitted !== null) {
          fileUri = await persistComposerAttachmentFile(
            fitted.uri,
            name,
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
          );
          await removePersistedComposerAttachmentFile(attachment.fileUri);
        }
      } catch (cause) {
        await removePersistedComposerAttachmentFile(attachment.fileUri);
        throw cause;
      }
      attachments.push(await ownedComposerImageAttachment({ fileUri, name, mimeType }));
    } catch (cause) {
      error = errorDisplayMessage(cause, m) ?? m(msg("Could not read ''{name}''.", { name }));
    }
  }
  if (exceededAttachmentLimit) {
    error = m(
      msg("You can attach up to {max} files per message.", {
        max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      }),
    );
  }
  return { files: attachments, error };
}

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error(m(msg("The photo library is unavailable right now.")), { cause: error });
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
  readonly acceptSelection?: () => boolean;
}): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      attachments: [],
      error: m(
        msg("You can attach up to {max} attachments per message.", {
          max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        }),
      ),
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      attachments: [],
      error: errorDisplayMessage(error, m) ?? m(msg("The photo library is unavailable right now.")),
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
      error: errorDisplayMessage(error, m) ?? m(msg("Could not open the photo library.")),
    };
  } finally {
    endHandoff();
  }

  if (result.canceled || input.acceptSelection?.() === false) {
    return {
      attachments: [],
      error: null,
    };
  }

  const attachments: DraftComposerAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    if (attachments.length >= remainingSlots) {
      error = m(
        msg("You can attach up to {max} attachments per message.", {
          max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        }),
      );
      break;
    }
    const mimeType = asset.mimeType?.toLowerCase();
    if (asset.type === "video" || mimeType?.startsWith("video/")) {
      if (input.maxVideoBytes === undefined) {
        error = m(msg("Video attachments are unavailable here."));
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
          errorDisplayMessage(cause, m) ??
          m(msg("Could not read ''{name}''.", { name: asset.fileName ?? "video" }));
      }
      continue;
    }
    if (asset.type !== "image" && !mimeType?.startsWith("image/")) {
      error = m(msg("Unsupported file type for ''{name}''.", { name: asset.fileName ?? "image" }));
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

    let image: { base64: string; mimeType: string; name: string; uri: string };
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
          uri: fitted?.uri ?? asset.uri,
        };
      } else {
        const rendered = await renderPhoto(asset.uri);
        image = {
          base64: rendered.base64,
          mimeType: "image/jpeg",
          name: /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "")}.jpg`,
          uri: rendered.uri,
        };
      }
    } catch {
      error = m(msg("Failed to read ''{name}''.", { name }));
      continue;
    }

    const sizeBytes = estimateBase64ByteSize(image.base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = m(msg("''{name}'' exceeds the 10 MB attachment limit.", { name }));
      continue;
    }

    try {
      const fileUri = await persistComposerAttachmentFile(
        image.uri,
        image.name,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      attachments.push(
        await ownedComposerImageAttachment({ fileUri, name: image.name, mimeType: image.mimeType }),
      );
    } catch (cause) {
      error = errorDisplayMessage(cause, m) ?? m(msg("Failed to read ''{name}''.", { name }));
    }
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
    return segments.at(-2) === OWNED_PASTED_IMAGE_DIRECTORY;
  } catch {
    return false;
  }
}

/** Leave out existingCount when the draft store caps after its duplicate check. */
export async function convertPastedImagesToAttachments(input: {
  readonly uris: ReadonlyArray<string>;
  readonly existingCount?: number;
}): Promise<{
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  const { File } = await import("expo-file-system");
  const remainingSlots =
    input.existingCount === undefined
      ? Number.POSITIVE_INFINITY
      : PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  const attachments: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const [index, uri] of input.uris.entries()) {
    const temporaryUris = isOwnedPastedImageUri(uri) ? [uri] : [];
    try {
      if (index >= Math.max(0, remainingSlots)) {
        continue;
      }
      const file = new File(uri);
      const reportedMimeType = file.type;
      const sourceMimeType = reportedMimeType?.startsWith("image/")
        ? reportedMimeType
        : mimeTypeFromUri(uri);
      let mimeType = isProviderSendTurnSupportedImageMimeType(sourceMimeType)
        ? sourceMimeType
        : "image/jpeg";
      const rendered = mimeType === sourceMimeType ? null : await renderPhoto(uri);
      const pastedBase64 = rendered?.base64 ?? (await file.base64());
      const fitted = rendered ?? (await fitComposerImage({ uri, mimeType, base64: pastedBase64 }));
      if (fitted !== null) {
        temporaryUris.push(fitted.uri);
      }
      let base64 = fitted?.base64 ?? pastedBase64;
      let sourceUri = fitted?.uri ?? uri;
      if (
        rendered === null &&
        estimateBase64ByteSize(base64) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ) {
        const jpeg = await renderPhoto(uri);
        temporaryUris.push(jpeg.uri);
        mimeType = "image/jpeg";
        base64 = jpeg.base64;
        sourceUri = jpeg.uri;
      }
      const sizeBytes = estimateBase64ByteSize(base64);
      if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error =
          sizeBytes > 0
            ? m(msg("A pasted image exceeds the 10 MB attachment limit."))
            : m(msg("Could not read a pasted image."));
        continue;
      }
      const name = `pasted-image.${mimeType.split("/")[1] ?? "png"}`;
      const fileUri = await persistComposerAttachmentFile(
        sourceUri,
        name,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      attachments.push(await ownedComposerImageAttachment({ fileUri, name, mimeType }));
    } catch (cause) {
      console.warn("Failed to read pasted image", uri, cause);
      error = m(msg("Could not read a pasted image."));
    } finally {
      for (const temporaryUri of temporaryUris) {
        try {
          const file = new File(temporaryUri);
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          console.warn("Failed to remove temporary pasted image", temporaryUri, error);
        }
      }
    }
  }

  return { attachments, error };
}
