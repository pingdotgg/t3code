import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { chatMarkdownImageSources } from "@t3tools/shared/markdownPipeline";

import { isImageAttachment, type ChatMessage, type ChatImageAttachment } from "../../types";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

type ConversationImageSource =
  | { readonly kind: "markdown"; readonly source: string }
  | { readonly kind: "attachment"; readonly attachment: ChatImageAttachment };

export function conversationImageSources(
  messages: ReadonlyArray<Pick<ChatMessage, "text" | "attachments">>,
  workspaceRoot?: string | null,
): ConversationImageSource[] {
  const result: ConversationImageSource[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const key = `attachment:${attachment.id}`;
      if (!isImageAttachment(attachment) || seen.has(key)) continue;
      const previewUrl = attachment.previewUrl;
      if (previewUrl?.startsWith("blob:") || previewUrl?.startsWith("data:")) continue;
      seen.add(key);
      result.push({ kind: "attachment", attachment });
    }
    for (const source of chatMarkdownImageSources(message.text)) {
      const classified = classifyMarkdownImageSource(source, workspaceRoot);
      if (classified._tag === "Blocked") continue;
      const key =
        classified._tag === "Direct"
          ? classified.uri
          : (mediaFileReference(classified.path, workspaceRoot).relativePath ?? classified.path);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ kind: "markdown", source });
    }
  }
  return result;
}

function archiveName(name: string, index: number, used: Set<string>): string {
  const base = name
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim();
  const safe = !base || base === "." || base === ".." ? `image-${index + 1}` : base;
  const extensionIndex = safe.lastIndexOf(".");
  const stem = extensionIndex > 0 ? safe.slice(0, extensionIndex) : safe;
  const extension = extensionIndex > 0 ? safe.slice(extensionIndex) : "";
  let result = safe;
  for (let suffix = 2; used.has(result.toLocaleLowerCase()); suffix++) {
    result = `${stem} (${suffix})${extension}`;
  }
  used.add(result.toLocaleLowerCase());
  return result;
}

interface ImageArchiveEntry {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const loadArchive = () => import("jszip");

export async function createImageArchive(entries: readonly ImageArchiveEntry[]): Promise<Blob> {
  if (entries.length === 0) throw new Error(m(msg("Select at least one image to download.")));
  if (entries.length > 65_535)
    throw new Error(m(msg("There are too many images for one download.")));
  const totalSize = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  if (totalSize > MAX_ARCHIVE_BYTES) {
    throw new Error(m(msg("This download exceeds 256 MB. Select fewer images and try again.")));
  }
  const { default: JSZip } = await loadArchive();
  const archive = new JSZip();
  const usedNames = new Set<string>();
  entries.forEach((entry, index) => {
    archive.file(archiveName(entry.name, index, usedNames), entry.bytes, {
      date: new Date("1980-01-01T00:00:00Z"),
      compression: "STORE",
    });
  });
  return archive.generateAsync({ type: "blob" });
}

export async function readImageArchive<T>(
  images: readonly T[],
  readImage: (image: T) => Promise<Blob>,
  imageName: (image: T) => string,
): Promise<Blob> {
  const entries: ImageArchiveEntry[] = [];
  let totalSize = 0;
  // Read in series so selecting a whole conversation cannot start unbounded requests.
  for (const image of images) {
    const blob = await readImage(image);
    totalSize += blob.size;
    if (totalSize > MAX_ARCHIVE_BYTES) {
      throw new Error(m(msg("This download exceeds 256 MB. Select fewer images and try again.")));
    }
    entries.push({ name: imageName(image), bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return createImageArchive(entries);
}

export async function downloadImageArchive<T>(
  images: readonly T[],
  readImage: (image: T) => Promise<Blob>,
  imageName: (image: T) => string,
): Promise<void> {
  const url = URL.createObjectURL(await readImageArchive(images, readImage, imageName));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "t3-images.zip";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
