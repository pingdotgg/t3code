import { PLUGIN_UPLOAD_MAX_BYTES, PLUGIN_UPLOAD_MAX_FILES } from "@t3tools/contracts";

const MANIFEST_FILE = "t3-plugin.json";
const MAX_DEPTH = 32;

export interface PluginFolder {
  readonly name: string;
  /** Rejects with an error meant for the user when the folder is not a plugin or too large. */
  readonly read: () => Promise<ReadonlyArray<PluginFolderFile>>;
}

export interface PluginFolderFile {
  /** Relative to the plugin folder, with `/` separators. */
  readonly path: string;
  readonly file: File;
}

// Version control history and installed dependencies are never part of a built plugin.
const LEFT_OUT = new Set([".git", "node_modules"]);
const isLeftOut = (path: string) => path.split("/").some((segment) => LEFT_OUT.has(segment));

const notAPlugin = (name: string) =>
  new Error(`${name} has no ${MANIFEST_FILE}, so it is not a T3 Code plugin.`);

const tooLarge = (name: string, files: ReadonlyArray<PluginFolderFile>) => {
  const bytesByEntry = new Map<string, number>();
  for (const { path, file } of files) {
    const entry = path.split("/")[0] ?? path;
    bytesByEntry.set(entry, (bytesByEntry.get(entry) ?? 0) + file.size);
  }
  const [largest] = [...bytesByEntry].toSorted((a, b) => b[1] - a[1]);
  return new Error(
    `${name} is too large. A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_FILES} files and ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB${largest === undefined ? "" : `, and most of it is in ${largest[0]}`}. Build the plugin and add the folder with only what it needs.`,
  );
};

function withinLimits(name: string, files: ReadonlyArray<PluginFolderFile>) {
  const bytes = files.reduce((total, { file }) => total + file.size, 0);
  if (files.length > PLUGIN_UPLOAD_MAX_FILES || bytes > PLUGIN_UPLOAD_MAX_BYTES) {
    throw tooLarge(name, files);
  }
  return files;
}

// `readEntries` hands out a folder's entries in batches and signals the end with an empty one.
async function entriesOf(folder: FileSystemDirectoryEntry) {
  const reader = folder.createReader();
  const entries: Array<FileSystemEntry> = [];
  for (;;) {
    const batch = await new Promise<Array<FileSystemEntry>>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function readDroppedFolder(folder: FileSystemDirectoryEntry) {
  const top = await entriesOf(folder);
  // Checked first, so dropping a large folder that is not a plugin reads nothing more.
  if (!top.some((entry) => entry.isFile && entry.name === MANIFEST_FILE)) {
    throw notAPlugin(folder.name);
  }
  const files: Array<PluginFolderFile> = [];
  let bytes = 0;
  const visit = async (entries: ReadonlyArray<FileSystemEntry>, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) throw tooLarge(folder.name, files);
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory) {
        if (isLeftOut(path)) continue;
        await visit(await entriesOf(entry as FileSystemDirectoryEntry), `${path}/`, depth + 1);
        continue;
      }
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      bytes += file.size;
      // Checked while walking, so a huge folder stops early.
      if (files.length >= PLUGIN_UPLOAD_MAX_FILES || bytes > PLUGIN_UPLOAD_MAX_BYTES) {
        throw tooLarge(folder.name, [...files, { path, file }]);
      }
      files.push({ path, file });
    }
  };
  await visit(top, "", 0);
  return withinLimits(folder.name, files);
}

/** Call during the drop event: the browser empties the transfer after it. */
export function droppedFolders(dataTransfer: DataTransfer): ReadonlyArray<PluginFolder> {
  return Array.from(dataTransfer.items).flatMap((item) => {
    const entry = item.kind === "file" ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory !== true) return [];
    const folder = entry as FileSystemDirectoryEntry;
    return [{ name: folder.name, read: () => readDroppedFolder(folder) }];
  });
}

export function pickedFolder(files: ReadonlyArray<File>): PluginFolder | undefined {
  const name = files[0]?.webkitRelativePath.split("/")[0];
  if (name === undefined || name === "") return undefined;
  return {
    name,
    read: async () => {
      const inside = files
        .map((file) => ({ path: file.webkitRelativePath.slice(name.length + 1), file }))
        .filter(({ path }) => !isLeftOut(path));
      if (!inside.some(({ path }) => path === MANIFEST_FILE)) throw notAPlugin(name);
      return withinLimits(name, inside);
    },
  };
}
