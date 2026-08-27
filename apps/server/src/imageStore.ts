// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";
import { normalizeAttachmentRelativePath } from "./attachmentPaths.ts";

const IMAGE_ID_PATTERN = new RegExp(
  `^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\\.[a-z0-9]{1,8})$`,
  "i",
);

export function createGeneratedImageId(extension: string): string | null {
  const normalized = extension.startsWith(".")
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;
  if (!SAFE_IMAGE_FILE_EXTENSIONS.has(normalized)) {
    return null;
  }
  return `${NodeCrypto.randomUUID()}${normalized}`;
}

export function parseGeneratedImageId(
  imageId: string,
): { readonly uuid: string; readonly extension: string } | null {
  const normalized = normalizeAttachmentRelativePath(imageId);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(IMAGE_ID_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { uuid: match[1].toLowerCase(), extension: match[2].toLowerCase() };
}

export function resolveGeneratedImagePath(input: {
  readonly imagesDir: string;
  readonly imageId: string;
}): string | null {
  const parsed = parseGeneratedImageId(input.imageId);
  if (!parsed) {
    return null;
  }
  const imagesRoot = NodePath.resolve(input.imagesDir);
  const filePath = NodePath.resolve(NodePath.join(imagesRoot, `${parsed.uuid}${parsed.extension}`));
  if (!filePath.startsWith(`${imagesRoot}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}

export function writeGeneratedImage(input: {
  readonly imagesDir: string;
  readonly imageId: string;
  readonly bytes: Uint8Array;
}): string | null {
  const filePath = resolveGeneratedImagePath(input);
  if (!filePath) {
    return null;
  }
  NodeFS.mkdirSync(input.imagesDir, { recursive: true });
  NodeFS.writeFileSync(filePath, input.bytes);
  return filePath;
}

export function copyGeneratedImage(input: {
  readonly imagesDir: string;
  readonly imageId: string;
  readonly sourcePath: string;
}): string | null {
  const filePath = resolveGeneratedImagePath(input);
  if (!filePath) {
    return null;
  }
  NodeFS.mkdirSync(input.imagesDir, { recursive: true });
  NodeFS.copyFileSync(input.sourcePath, filePath);
  return filePath;
}
