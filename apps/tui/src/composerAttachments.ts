import * as NodeBuffer from "node:buffer";

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { decodeImage, type RgbaImage } from "@t3tools/opentui-image";

const PREVIEW_MAX_WIDTH = 240;
const PREVIEW_MAX_HEIGHT = 160;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

export interface Base64WorkspaceFile {
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface ComposerImageAttachment {
  readonly relativePath: string;
  readonly upload: UploadChatImageAttachment;
  readonly preview: RgbaImage;
}

export function imageMimeTypeForPath(relativePath: string): string | null {
  const extension = relativePath.split(".").at(-1)?.toLowerCase();
  return extension ? (IMAGE_MIME_BY_EXTENSION[extension] ?? null) : null;
}

export function isSupportedImagePath(relativePath: string): boolean {
  return imageMimeTypeForPath(relativePath) !== null;
}

export function removeComposerImage(
  images: ReadonlyArray<ComposerImageAttachment>,
  relativePath: string,
): ReadonlyArray<ComposerImageAttachment> {
  return images.filter((image) => image.relativePath !== relativePath);
}

export async function prepareComposerImage(
  relativePath: string,
  file: Base64WorkspaceFile,
  decoder: (encoded: Uint8Array) => Promise<RgbaImage> = (encoded) =>
    decodeImage(encoded, { maxWidth: PREVIEW_MAX_WIDTH, maxHeight: PREVIEW_MAX_HEIGHT }),
): Promise<ComposerImageAttachment> {
  const mimeType = imageMimeTypeForPath(relativePath);
  if (!mimeType) throw new Error("Select a supported image file.");
  if (file.truncated || file.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the 10MB attachment limit.");
  }
  if (file.byteLength <= 0) throw new Error("Image file is empty.");
  if (file.contents.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(file.contents)) {
    throw new Error("Image payload is not valid base64.");
  }

  const encoded = NodeBuffer.Buffer.from(file.contents, "base64");
  if (encoded.byteLength !== file.byteLength) {
    throw new Error("Image changed while it was being loaded.");
  }
  const name = relativePath.split(/[\\/]/).at(-1)?.trim() ?? "";
  if (name.length === 0 || name.length > 255) throw new Error("Image filename is invalid.");

  const preview = await decoder(encoded);
  return {
    relativePath,
    upload: {
      type: "image",
      name,
      mimeType,
      sizeBytes: encoded.byteLength,
      dataUrl: `data:${mimeType};base64,${file.contents}`,
    },
    preview,
  };
}
