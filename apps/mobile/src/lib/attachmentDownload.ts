import type { ChatFileAttachment } from "@t3tools/contracts";
import type { Directory } from "expo-file-system";

import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

const ATTACHMENT_DOWNLOAD_DIRECTORY = "t3-attachment-downloads";
const DOWNLOAD_RETENTION_MS = 24 * 60 * 60_000;
const DOWNLOAD_DIRECTORY_NAME = /^(\d+)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const activeDirectories = new Set<string>();

function downloadFileName(name: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "_"
      : character;
  })
    .join("")
    .trim();
  if (!sanitized || /^\.+$/.test(sanitized)) {
    return "attachment";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(sanitized).byteLength <= 255) {
    return sanitized;
  }
  const extensionMatch = /\.[a-z0-9]{1,16}$/i.exec(sanitized);
  const extension = extensionMatch && extensionMatch.index > 0 ? extensionMatch[0] : "";
  const stem = extension ? sanitized.slice(0, -extension.length) : sanitized;
  let remainingBytes = 255 - encoder.encode(extension).byteLength;
  let shortStem = "";
  for (const character of stem) {
    const bytes = encoder.encode(character).byteLength;
    if (bytes > remainingBytes) break;
    shortStem += character;
    remainingBytes -= bytes;
  }
  return `${shortStem || "attachment"}${extension}`;
}

function removeDownloadDirectory(directory: Directory): void {
  try {
    if (directory.exists) {
      directory.delete();
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not remove a cached file", error);
  }
}

/** Downloads original bytes for the native save/share sheet, including inline video responses. */
export async function downloadAndShareAttachment(input: {
  readonly url: string;
  readonly attachment: Pick<ChatFileAttachment, "name" | "mimeType">;
  readonly signal: AbortSignal;
}): Promise<void> {
  const [{ Directory, File, Paths }, Sharing] = await Promise.all([
    import("expo-file-system"),
    import("expo-sharing"),
  ]);
  if (input.signal.aborted) return;
  const canShare = await Sharing.isAvailableAsync();
  if (input.signal.aborted) return;
  if (!canShare) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }

  const cache = new Directory(Paths.cache, ATTACHMENT_DOWNLOAD_DIRECTORY);
  cache.create({ idempotent: true, intermediates: true });
  const now = Date.now();
  try {
    for (const entry of cache.list()) {
      const match = DOWNLOAD_DIRECTORY_NAME.exec(entry.name);
      if (
        entry instanceof Directory &&
        match &&
        Number(match[1]) < now - DOWNLOAD_RETENTION_MS &&
        !activeDirectories.has(entry.uri)
      ) {
        removeDownloadDirectory(entry);
      }
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not inspect cached files", error);
  }

  const directory = new Directory(cache, `${now}-${uuidv4()}`);
  activeDirectories.add(directory.uri);
  let shared = false;
  let openingShareSheet = false;
  try {
    directory.create();
    const destination = new File(directory, downloadFileName(input.attachment.name));
    const file = await File.downloadFileAsync(input.url, destination, { signal: input.signal });
    if (input.signal.aborted) return;

    openingShareSheet = true;
    const endHandoff = beginForegroundHandoff();
    try {
      await Sharing.shareAsync(file.uri, {
        mimeType: input.attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
        dialogTitle: input.attachment.name,
      });
      shared = true;
    } finally {
      endHandoff();
    }
  } catch (cause) {
    if (input.signal.aborted) return;
    throw new Error(
      openingShareSheet
        ? "Could not open the share sheet. Try again."
        : "Could not download the attachment. Check the connection and try again.",
      { cause },
    );
  } finally {
    activeDirectories.delete(directory.uri);
    // A receiver can still be reading after Android's chooser returns.
    // Successful exports expire on a later open; partial downloads do not.
    if (!shared) {
      removeDownloadDirectory(directory);
    }
  }
}
