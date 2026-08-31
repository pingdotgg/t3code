import type { ChatFileAttachment } from "@t3tools/contracts";
import type { Directory } from "expo-file-system";
import type { SharingOptions } from "expo-sharing";

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

type AttachmentFileMetadata = Pick<ChatFileAttachment, "name" | "mimeType">;

export interface AttachmentPreviewFile {
  readonly uri: string;
  readonly share: (signal: AbortSignal, sourceIdentifier?: string) => Promise<void>;
  readonly dispose: () => void;
}

async function availableSharing(signal: AbortSignal) {
  if (signal.aborted) return null;
  const Sharing = await import("expo-sharing");
  const canShare = await Sharing.isAvailableAsync();
  if (signal.aborted) return null;
  if (!canShare) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  return Sharing;
}

async function createCachedAttachmentFile(attachment: AttachmentFileMetadata) {
  const { Directory, File, Paths } = await import("expo-file-system");
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
  directory.create();
  let file: InstanceType<typeof File>;
  try {
    file = new File(directory, downloadFileName(attachment.name));
  } catch (error) {
    removeDownloadDirectory(directory);
    throw error;
  }
  activeDirectories.add(directory.uri);
  let disposed = false;
  let shared = false;
  let sharing = false;
  const release = () => {
    if (!disposed || sharing) return;
    activeDirectories.delete(directory.uri);
    // A receiver can still be reading after Android's chooser returns.
    if (!shared) removeDownloadDirectory(directory);
  };
  const preview: AttachmentPreviewFile = {
    uri: file.uri,
    dispose: () => {
      disposed = true;
      release();
    },
    share: async (signal, sourceIdentifier) => {
      if (disposed || sharing || signal.aborted) return;
      sharing = true;
      try {
        const Sharing = await availableSharing(signal);
        if (Sharing === null || disposed) return;
        const endHandoff = beginForegroundHandoff();
        try {
          const options: SharingOptions = {
            mimeType: attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
            dialogTitle: attachment.name,
          };
          if (sourceIdentifier) {
            const { shareFileFromSource } = await import("./shareFileFromSource");
            if (signal.aborted || disposed) return;
            await shareFileFromSource(file.uri, options, sourceIdentifier);
          } else {
            await Sharing.shareAsync(file.uri, options);
          }
          shared = true;
        } catch (cause) {
          if (!signal.aborted) {
            throw new Error("Could not open the share sheet. Try again.", { cause });
          }
        } finally {
          endHandoff();
        }
      } finally {
        sharing = false;
        release();
      }
    },
  };
  return { file, preview };
}

/** The caller owns this cached file until disposal, unless it has been shared with another app. */
export async function downloadAttachmentForPreview(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<AttachmentPreviewFile | null> {
  if (input.signal.aborted) return null;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (input.signal.aborted) {
      cached.preview.dispose();
      return null;
    }
    await File.downloadFileAsync(input.url, cached.file, { signal: input.signal });
    if (input.signal.aborted) {
      cached.preview.dispose();
      return null;
    }
    return cached.preview;
  } catch (cause) {
    // Android may leave a partial file after a failed or interrupted request.
    cached.preview.dispose();
    if (input.signal.aborted) return null;
    throw new Error("Could not download the attachment. Check the connection and try again.", {
      cause,
    });
  }
}

/** Downloads original bytes for the native save/share sheet, including inline video responses. */
export async function downloadAndShareAttachment(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const file = await downloadAttachmentForPreview(input);
  if (file === null) return;
  try {
    await file.share(input.signal, input.sourceIdentifier);
  } finally {
    file.dispose();
  }
}

/** Shares a cache copy so another app never relies on the lifetime of a composer draft. */
export async function shareLocalAttachment(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (input.signal.aborted) return;
    try {
      await new File(input.uri).copy(cached.file);
    } catch (cause) {
      if (input.signal.aborted) return;
      throw new Error("Could not prepare the attachment for sharing.", { cause });
    }
    if (!input.signal.aborted) {
      await cached.preview.share(input.signal, input.sourceIdentifier);
    }
  } finally {
    cached.preview.dispose();
  }
}
