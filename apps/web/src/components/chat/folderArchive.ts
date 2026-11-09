import * as Schema from "effect/Schema";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

// Matches ARCHIVE_MAX_ENTRIES in boundedZip so the chip still previews; importing it would load JSZip eagerly.
const FOLDER_ARCHIVE_MAX_ENTRIES = 2048;
const FOLDER_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const SKIPPED_NAMES = new Set([".git", "node_modules"]);

export interface FolderArchiveEntry {
  readonly relativePath: string;
  readonly file: File;
}

export interface FolderCollection {
  readonly folderName: string;
  /** Paths start with `<folderName>/`. */
  readonly entries: ReadonlyArray<FolderArchiveEntry>;
  readonly totalBytes: number;
  /** Skipped names (`.git`, `node_modules`) with how many folders of that name were left out. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly count: number }>;
}

/** A user-facing refusal; `message` is ready to show in a toast. */
export class FolderArchiveError extends Schema.TaggedError<FolderArchiveError>()(
  "FolderArchiveError",
  {
    reason: Schema.Literals(["too-many-entries", "too-large", "empty", "zip-too-large"]),
    message: Schema.String,
  },
) {}

class FolderCollector {
  private readonly entries: FolderArchiveEntry[] = [];
  private readonly directories = new Set<string>();
  private readonly skipped = new Map<string, Set<string>>();
  private totalBytes = 0;

  constructor(readonly folderName: string) {}

  skip(relativePath: string): boolean {
    const segments = relativePath.split("/");
    // The first segment is the attached folder itself, which is never skipped.
    for (let index = 1; index < segments.length; index++) {
      const name = segments[index]!;
      if (!SKIPPED_NAMES.has(name)) continue;
      const paths = this.skipped.get(name) ?? new Set<string>();
      paths.add(segments.slice(0, index + 1).join("/"));
      this.skipped.set(name, paths);
      return true;
    }
    return false;
  }

  add(relativePath: string, file: File): void {
    // JSZip writes an entry for every parent folder, and the preview counts those too.
    for (let slash = relativePath.indexOf("/"); slash !== -1;) {
      this.directories.add(relativePath.slice(0, slash + 1));
      slash = relativePath.indexOf("/", slash + 1);
    }
    this.entries.push({ relativePath, file });
    this.totalBytes += file.size;
    const name = this.folderName;
    if (this.entries.length + this.directories.size > FOLDER_ARCHIVE_MAX_ENTRIES) {
      throw new FolderArchiveError({
        reason: "too-many-entries",
        message: `'${name}' has more than ${FOLDER_ARCHIVE_MAX_ENTRIES.toLocaleString("en-US")} files and folders. Attach a smaller folder or zip it yourself.`,
      });
    }
    if (this.totalBytes > FOLDER_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
      throw new FolderArchiveError({
        reason: "too-large",
        message: `'${name}' is larger than ${FOLDER_ARCHIVE_MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MB before compression.`,
      });
    }
  }

  finish(): FolderCollection {
    if (this.entries.length === 0) {
      throw new FolderArchiveError({ reason: "empty", message: `'${this.folderName}' is empty.` });
    }
    return {
      folderName: this.folderName,
      entries: this.entries,
      totalBytes: this.totalBytes,
      skipped: Array.from(this.skipped, ([name, paths]) => ({ name, count: paths.size })),
    };
  }
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Walks a dropped or pasted folder. Capture `dir` from `webkitGetAsEntry()` before any await
 * in the event handler; the entry stops working once the handler returns.
 */
export async function collectFolderEntries(
  dir: FileSystemDirectoryEntry,
  signal?: AbortSignal,
): Promise<FolderCollection> {
  const collector = new FolderCollector(dir.name);

  async function walk(directory: FileSystemDirectoryEntry, path: string): Promise<void> {
    const reader = directory.createReader();
    // Chromium returns at most 100 entries per call; an empty batch marks the end.
    for (;;) {
      signal?.throwIfAborted();
      const batch = await readBatch(reader);
      if (batch.length === 0) return;
      const fileEntries: Array<{ path: string; entry: FileSystemFileEntry }> = [];
      const subdirectories: Array<{ path: string; entry: FileSystemDirectoryEntry }> = [];
      for (const entry of batch) {
        const childPath = `${path}/${entry.name}`;
        if (collector.skip(childPath)) continue;
        if (entry.isDirectory) {
          subdirectories.push({ path: childPath, entry: entry as FileSystemDirectoryEntry });
        } else if (entry.isFile) {
          fileEntries.push({ path: childPath, entry: entry as FileSystemFileEntry });
        }
      }
      const files = await Promise.all(fileEntries.map(({ entry }) => readFile(entry)));
      signal?.throwIfAborted();
      fileEntries.forEach(({ path: filePath }, index) => collector.add(filePath, files[index]!));
      for (const subdirectory of subdirectories) await walk(subdirectory.entry, subdirectory.path);
    }
  }

  await walk(dir, dir.name);
  return collector.finish();
}

export function collectPickedFolderEntries(files: Iterable<File>): FolderCollection {
  let collector: FolderCollector | null = null;
  for (const file of files) {
    // `webkitRelativePath` already starts with the picked folder's name.
    const relativePath = file.webkitRelativePath || file.name;
    collector ??= new FolderCollector(relativePath.split("/")[0]!);
    if (collector.skip(relativePath)) continue;
    collector.add(relativePath, file);
  }
  if (collector === null)
    throw new FolderArchiveError({ reason: "empty", message: "This folder is empty." });
  return collector.finish();
}

export async function buildFolderZip(
  collection: FolderCollection,
  options: { readonly maxZipBytes: number; readonly signal?: AbortSignal },
): Promise<File> {
  const { signal, maxZipBytes } = options;
  signal?.throwIfAborted();
  // Loaded on demand so JSZip stays out of the composer bundle.
  const { default: JSZip } = await import("jszip");
  signal?.throwIfAborted();
  const zip = new JSZip();
  for (const { relativePath, file } of collection.entries) {
    zip.file(relativePath, file.arrayBuffer(), { date: new Date(file.lastModified) });
  }
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    streamFiles: true,
  });
  signal?.throwIfAborted();
  const zipName = `${collection.folderName}.zip`;
  if (blob.size > maxZipBytes) {
    throw new FolderArchiveError({
      reason: "zip-too-large",
      message: `'${zipName}' is ${formatAttachmentSize(blob.size)} after compression; the limit is ${formatAttachmentSize(maxZipBytes)}.`,
    });
  }
  return new File([blob], zipName, { type: "application/zip" });
}
