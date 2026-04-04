import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";

import { newClientId } from "./clientId";

export interface DraftComposerImageAttachment extends UploadChatImageAttachment {
  readonly id: string;
  readonly previewUri: string;
}

function estimateBase64ByteSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

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

  const permission = await imagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      images: [],
      error: "Allow photo library access to attach images.",
    };
  }

  const result = await imagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: remainingSlots,
    base64: true,
    quality: 1,
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
      id: newClientId("attachment"),
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
          id: newClientId("attachment"),
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
