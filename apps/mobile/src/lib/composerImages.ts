import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { estimateBase64ByteSize } from "./base64";
import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

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
const HEIF_IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
  "image/vnd.android.heic",
  "image/x-heic",
  "image/x-heif",
]);

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("Image attachments are unavailable right now.", { cause: error });
  }
}

async function loadClipboard() {
  try {
    return await import("expo-clipboard");
  } catch (error) {
    throw new Error("Clipboard paste is unavailable right now.", { cause: error });
  }
}

function isHeifImage(mimeType: string | undefined, fileName: string | null | undefined): boolean {
  return (
    (mimeType !== undefined && HEIF_IMAGE_MIME_TYPES.has(mimeType)) ||
    /\.(?:heic|heif)$/i.test(fileName ?? "")
  );
}

function jpegFileName(fileName: string | null | undefined): string {
  const stem = (fileName ?? "image").replace(/\.(?:heic|heif)$/i, "");
  return `${stem.slice(0, 251)}.jpg`;
}

async function convertHeifImage(
  uri: string,
): Promise<{ readonly base64: string; readonly uri: string }> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const context = ImageManipulator.manipulate(uri);
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | null = null;

  try {
    rendered = await context.renderAsync();
    const result = await rendered.saveAsync({
      base64: true,
      compress: 0.9,
      format: SaveFormat.JPEG,
    });
    if (!result.base64) {
      throw new Error("HEIF conversion did not return image data.");
    }
    return { base64: result.base64, uri: result.uri };
  } finally {
    rendered?.release();
    context.release();
  }
}

export async function pickComposerImages(input: { readonly existingCount: number }): Promise<{
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  readonly error: string | null;
}> {
  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;
  if (remainingSlots <= 0) {
    return {
      images: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    };
  }

  let imagePicker: Awaited<ReturnType<typeof loadImagePicker>>;
  try {
    imagePicker = await loadImagePicker();
  } catch (error) {
    return {
      images: [],
      error:
        error instanceof Error ? error.message : "Image attachments are unavailable right now.",
    };
  }

  // The picker covers the Android activity, which reports the app as
  // backgrounded; the guard keeps background-triggered restarts away mid-pick.
  const endHandoff = beginForegroundHandoff();
  let result: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      base64: true,
      quality: 1,
    });
  } finally {
    endHandoff();
  }

  if (result.canceled) {
    return {
      images: [],
      error: null,
    };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const originalMimeType = asset.mimeType?.toLowerCase();
    let mimeType = originalMimeType;
    let fileName = asset.fileName ?? "image";
    let base64 = asset.base64;
    let previewUri = asset.uri;
    let sizeBytes = asset.fileSize;
    let convertedFromHeif = false;

    if (isHeifImage(originalMimeType, asset.fileName)) {
      try {
        const converted = await convertHeifImage(asset.uri);
        mimeType = "image/jpeg";
        fileName = jpegFileName(asset.fileName);
        base64 = converted.base64;
        previewUri = converted.uri;
        sizeBytes = undefined;
        convertedFromHeif = true;
      } catch {
        error = `Failed to convert '${asset.fileName ?? "image"}' to JPEG.`;
        continue;
      }
    }

    if (!mimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${fileName}'.`;
      continue;
    }
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
      error = `'${fileName}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`;
      continue;
    }

    if (!base64) {
      try {
        const { File } = await import("expo-file-system");
        base64 = await new File(asset.uri).base64();
      } catch {
        // Keep the existing user-facing error below when the picker URI cannot
        // be read on a particular Android media provider.
      }
    }
    if (!base64) {
      error = `Failed to read '${fileName}'.`;
      continue;
    }

    sizeBytes ??= estimateBase64ByteSize(base64);
    if (sizeBytes <= 0 || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = convertedFromHeif
        ? `'${asset.fileName ?? "image"}' exceeds the 10 MB attachment limit after JPEG conversion.`
        : `'${fileName}' exceeds the 10 MB attachment limit.`;
      continue;
    }

    nextImages.push({
      id: uuidv4(),
      type: "image",
      name: fileName,
      mimeType,
      sizeBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
      previewUri,
    });
  }

  return {
    images: nextImages,
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
