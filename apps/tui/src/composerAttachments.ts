import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";

import {
  CHAT_IMAGE_MIME_BY_EXTENSION,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { decodeImage, type RgbaImage } from "@t3tools/opentui-image";

const PREVIEW_MAX_WIDTH = 240;
const PREVIEW_MAX_HEIGHT = 160;

// Shared with the server, which gates base64 workspace reads to this list.
const IMAGE_MIME_BY_EXTENSION = CHAT_IMAGE_MIME_BY_EXTENSION;

const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/webp": "webp",
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

function hasUnescapedWhitespace(value: string): boolean {
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (/\s/u.test(character)) return true;
  }
  return false;
}

/**
 * Resolve a complete prompt paste into either a workspace-relative path or an
 * explicit local path.
 *
 * Terminal file paste/drag-and-drop usually supplies a path rather than image
 * clipboard bytes. Keep recognition intentionally narrow: one path, a supported
 * extension. Workspace files keep using the server's guarded reader; explicit
 * paths (including `~/Pictures/...`) are read by the local TUI process.
 */
export function resolvePastedImagePath(
  pastedText: string,
  workspaceRoot: string,
  homeDirectory: string,
  platform: NodeJS.Platform,
): string | null {
  if (workspaceRoot.trim().length === 0 || pastedText.includes("\n") || pastedText.includes("\0")) {
    return null;
  }

  let candidate = pastedText.trim();
  if (candidate.length === 0) return null;
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const quote = candidate[0];
  const wasQuoted = (quote === "'" || quote === '"') && candidate.at(-1) === quote;
  if (wasQuoted) {
    candidate = candidate.slice(1, -1);
  }
  const isAnchoredPosixPath =
    candidate.startsWith("/") ||
    candidate.startsWith("~/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../");
  if (
    platform !== "win32" &&
    !wasQuoted &&
    hasUnescapedWhitespace(candidate) &&
    !isAnchoredPosixPath
  ) {
    return null;
  }
  const wasShellEscaped = platform !== "win32" && /\\./u.test(candidate);
  if (platform !== "win32") {
    // Terminal drag/drop commonly shell-escapes spaces and punctuation.
    candidate = candidate.replace(/\\(.)/gu, "$1");
  }
  if (candidate === "~") {
    candidate = homeDirectory;
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(homeDirectory, candidate.slice(2));
  } else if (candidate.startsWith("~")) {
    // `~other-user` expansion is shell-specific and cannot be resolved safely.
    return null;
  }
  if (!isSupportedImagePath(candidate)) return null;

  if (/\s/u.test(candidate) && !wasQuoted && !wasShellEscaped && !path.isAbsolute(candidate)) {
    return null;
  }
  const normalizedRoot = path.resolve(workspaceRoot);
  if (path.isAbsolute(candidate)) {
    const absolutePath = path.resolve(candidate);
    const workspaceRelativePath = path.relative(normalizedRoot, absolutePath);
    return workspaceRelativePath !== ".." &&
      !workspaceRelativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(workspaceRelativePath)
      ? workspaceRelativePath
      : absolutePath;
  }
  return path.normalize(candidate);
}

export interface PromptImagePathLine {
  readonly lineIndex: number;
  readonly text: string;
  readonly imagePath: string;
}

export interface PastedImagePath {
  readonly imagePath: string;
  readonly remainingText: string;
}

/**
 * Find one image path in pasted prompt text.
 *
 * A path-only paste is consumed completely. When a terminal paste also includes
 * prose, keep that prose in the composer and consume only an anchored local
 * path (`~/`, `/`, `./`, or `../`). This avoids treating the entire sentence as
 * a filename while still staging the image the user pasted.
 */
export function extractPastedImagePath(
  pastedText: string,
  workspaceRoot: string,
  homeDirectory: string,
  platform: NodeJS.Platform,
): PastedImagePath | null {
  const completePath = resolvePastedImagePath(pastedText, workspaceRoot, homeDirectory, platform);
  if (completePath) return { imagePath: completePath, remainingText: "" };

  const pathStartPattern =
    platform === "win32"
      ? /(^|[\s([{])(?:[a-z]:[\\/]|\\\\)(?=\S)/giu
      : /(^|[\s([{])(?:~\/|\/|\.\.?\/)(?=\S)/gu;
  const extensionPattern = /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?=$|[\s,;:!?)}\]])/giu;

  for (const startMatch of pastedText.matchAll(pathStartPattern)) {
    const prefixLength = startMatch[1]?.length ?? 0;
    const pathStart = (startMatch.index ?? 0) + prefixLength;
    extensionPattern.lastIndex = pathStart;
    const extensionMatch = extensionPattern.exec(pastedText);
    if (!extensionMatch) continue;

    const pathEnd = extensionMatch.index + extensionMatch[0].length;
    const rawPath = pastedText.slice(pathStart, pathEnd);
    if (rawPath.includes("\n") || rawPath.includes("\0")) continue;
    const imagePath = resolvePastedImagePath(rawPath, workspaceRoot, homeDirectory, platform);
    if (!imagePath) continue;

    const before = pastedText.slice(0, pathStart);
    let after = pastedText.slice(pathEnd);
    if (before.endsWith(" ") && after.startsWith(" ")) after = after.slice(1);
    return { imagePath, remainingText: `${before}${after}` };
  }
  return null;
}

/** Find image paths in prompt lines, including content returned by `$EDITOR`. */
export function findPromptImagePathLines(
  prompt: string,
  workspaceRoot: string,
  homeDirectory: string,
  platform: NodeJS.Platform,
): ReadonlyArray<PromptImagePathLine> {
  const matches: PromptImagePathLine[] = [];
  for (const [lineIndex, text] of prompt.split("\n").entries()) {
    const pastedImage = extractPastedImagePath(text, workspaceRoot, homeDirectory, platform);
    if (pastedImage) matches.push({ lineIndex, text, imagePath: pastedImage.imagePath });
  }
  return matches;
}

/** Replace successfully attached image-path lines with their remaining prompt text. */
export function replacePromptLines(
  prompt: string,
  replacements: ReadonlyMap<number, string>,
): string {
  return prompt
    .split("\n")
    .map((line, index) => replacements.get(index) ?? line)
    .join("\n");
}

/** Remove only successfully attached path lines while preserving all other editor text. */
export function removePromptLines(prompt: string, lineIndexes: ReadonlySet<number>): string {
  return prompt
    .split("\n")
    .filter((_, index) => !lineIndexes.has(index))
    .join("\n");
}

export function imageExtensionForMimeType(mimeType: string): string | null {
  const baseMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return IMAGE_EXTENSION_BY_MIME[baseMimeType] ?? null;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return imageExtensionForMimeType(mimeType) !== null;
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
  return prepareComposerImageBytes(relativePath, mimeType, encoded, decoder);
}

export async function prepareComposerImageBytes(
  relativePath: string,
  mimeType: string,
  encoded: Uint8Array,
  decoder: (encoded: Uint8Array) => Promise<RgbaImage> = (value) =>
    decodeImage(value, { maxWidth: PREVIEW_MAX_WIDTH, maxHeight: PREVIEW_MAX_HEIGHT }),
): Promise<ComposerImageAttachment> {
  const extension = imageExtensionForMimeType(mimeType);
  if (!extension) throw new Error("Paste a supported image format.");
  if (encoded.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the 10MB attachment limit.");
  }
  if (encoded.byteLength <= 0) throw new Error("Image file is empty.");

  const name = relativePath.split(/[\\/]/).at(-1)?.trim() ?? "";
  if (name.length === 0 || name.length > 255) throw new Error("Image filename is invalid.");

  const preview = await decoder(encoded);
  const canonicalMimeType = IMAGE_MIME_BY_EXTENSION[extension] ?? mimeType;
  const base64 = NodeBuffer.Buffer.from(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  ).toString("base64");
  return {
    relativePath,
    upload: {
      type: "image",
      name,
      mimeType: canonicalMimeType,
      sizeBytes: encoded.byteLength,
      dataUrl: `data:${canonicalMimeType};base64,${base64}`,
    },
    preview,
  };
}
