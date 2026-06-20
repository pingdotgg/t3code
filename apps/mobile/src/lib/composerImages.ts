import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Schema from "effect/Schema";
import { uuidv4 } from "./uuid";

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

const OWNED_PASTED_IMAGE_DIRECTORY = "t3-composer-paste";

export class ComposerImageOperationError extends Schema.TaggedErrorClass<ComposerImageOperationError>()(
  "ComposerImageOperationError",
  {
    operation: Schema.Literals([
      "load-image-picker",
      "request-media-library-permission",
      "launch-image-library",
      "load-clipboard",
      "check-clipboard-image",
      "read-clipboard-image",
      "check-clipboard-text",
      "read-clipboard-text",
      "read-pasted-image",
      "remove-pasted-image",
    ]),
    uriLength: Schema.optional(Schema.Number),
    uriProtocol: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer image operation ${this.operation} failed${this.uriLength === undefined ? "" : ` for a ${this.uriProtocol ?? "unknown-protocol"} URI (length ${this.uriLength})`}.`;
  }
}

function estimateBase64ByteSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

async function loadImagePicker() {
  try {
    return await import("expo-image-picker");
  } catch (cause) {
    throw new ComposerImageOperationError({
      operation: "load-image-picker",
      cause,
    });
  }
}

async function loadClipboard() {
  try {
    return await import("expo-clipboard");
  } catch (cause) {
    throw new ComposerImageOperationError({
      operation: "load-clipboard",
      cause,
    });
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
    console.warn("[composer-images] image picker unavailable", error);
    return {
      images: [],
      error: "Image attachments are unavailable right now.",
    };
  }

  const permission = await imagePicker.requestMediaLibraryPermissionsAsync().catch((cause) => {
    throw new ComposerImageOperationError({
      operation: "request-media-library-permission",
      cause,
    });
  });
  if (!permission.granted) {
    return {
      images: [],
      error: "Allow photo library access to attach images.",
    };
  }

  const result = await imagePicker
    .launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      base64: true,
      quality: 1,
    })
    .catch((cause) => {
      throw new ComposerImageOperationError({
        operation: "launch-image-library",
        cause,
      });
    });

  if (result.canceled) {
    return {
      images: [],
      error: null,
    };
  }

  const nextImages: DraftComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const asset of result.assets) {
    const mimeType = asset.mimeType?.toLowerCase();
    if (!mimeType?.startsWith("image/")) {
      error = `Unsupported file type for '${asset.fileName ?? "image"}'.`;
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

    nextImages.push({
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
    console.warn("[composer-images] clipboard unavailable", error);
    return {
      images: [],
      text: null,
      error: "Clipboard paste is unavailable right now.",
    };
  }

  const remainingSlots = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - input.existingCount;

  const hasImage = await clipboard.hasImageAsync().catch((cause) => {
    throw new ComposerImageOperationError({
      operation: "check-clipboard-image",
      cause,
    });
  });
  if (hasImage) {
    if (remainingSlots <= 0) {
      return {
        images: [],
        text: null,
        error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
      };
    }
    const image = await clipboard.getImageAsync({ format: "png" }).catch((cause) => {
      throw new ComposerImageOperationError({
        operation: "read-clipboard-image",
        cause,
      });
    });
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

  const hasText = await clipboard.hasStringAsync().catch((cause) => {
    throw new ComposerImageOperationError({
      operation: "check-clipboard-text",
      cause,
    });
  });
  if (hasText) {
    const text = await clipboard.getStringAsync().catch((cause) => {
      throw new ComposerImageOperationError({
        operation: "read-clipboard-text",
        cause,
      });
    });
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

function describeComposerImageUri(uri: string) {
  const diagnostics = getUrlDiagnostics(uri);
  return {
    uriLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { uriProtocol: diagnostics.protocol }),
  };
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
    } catch (cause) {
      console.warn(
        "[composer-images] failed to read pasted image",
        new ComposerImageOperationError({
          operation: "read-pasted-image",
          ...describeComposerImageUri(uri),
          cause,
        }),
      );
    } finally {
      if (ownedTemporaryFile) {
        try {
          const file = new File(uri);
          if (file.exists) {
            file.delete();
          }
        } catch (cause) {
          console.warn(
            "[composer-images] failed to remove temporary pasted image",
            new ComposerImageOperationError({
              operation: "remove-pasted-image",
              ...describeComposerImageUri(uri),
              cause,
            }),
          );
        }
      }
    }
  }

  return results;
}
