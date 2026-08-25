import { isProviderSendTurnSupportedDocumentMimeType } from "@t3tools/contracts";

/**
 * Plain-text drops are inlined into the prompt rather than uploaded. A dropped
 * file has no filesystem path the environment could open — browsers never
 * expose one, and a remote environment could not read a local path anyway — so
 * the contents are the only thing that can actually cross the wire.
 */
export const MAX_INLINE_TEXT_FILE_BYTES = 256 * 1024;

const TEXT_FILE_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".mdx"]);
const TEXT_FILE_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

export type DroppedFileKind = "image" | "document" | "text" | "unsupported";

export interface DroppedFileLike {
  readonly name: string;
  readonly type: string;
}

export function fileExtension(fileName: string): string {
  const match = /\.[a-z0-9]+$/i.exec(fileName.trim());
  return match ? match[0].toLowerCase() : "";
}

/**
 * Kind of composer handling a dropped file gets. Extension wins over mime type
 * for text because browsers report an empty type for many `.md` files.
 */
export function classifyDroppedFile(
  file: DroppedFileLike,
  options: { readonly isHeicImage: boolean },
): DroppedFileKind {
  const mimeType = file.type.trim().toLowerCase();
  if (options.isHeicImage || mimeType.startsWith("image/")) {
    return "image";
  }
  if (isProviderSendTurnSupportedDocumentMimeType(mimeType)) {
    return "document";
  }
  const extension = fileExtension(file.name);
  if (TEXT_FILE_EXTENSIONS.has(extension) || TEXT_FILE_MIME_TYPES.has(mimeType)) {
    return "text";
  }
  // A PDF dragged from some apps arrives with an empty mime type.
  return extension === ".pdf" ? "document" : "unsupported";
}

/**
 * Wraps inlined file contents in a fence long enough to survive whatever
 * backticks the file itself contains, so a dropped markdown file cannot
 * terminate its own block.
 */
export function formatInlinedTextFile(input: {
  readonly name: string;
  readonly contents: string;
}): string {
  const longestBacktickRun = [...input.contents.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const body = input.contents.replace(/\s+$/, "");
  return `${input.name}:\n${fence}\n${body}\n${fence}`;
}
