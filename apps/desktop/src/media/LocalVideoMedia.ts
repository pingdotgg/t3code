// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Video files the renderer may play as a background. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".mp4",
  ".m4v",
  ".webm",
  ".mov",
  ".mkv",
  ".ogv",
]);

/** The path the app's own scheme serves local videos under. */
export const LOCAL_MEDIA_PATHNAME = "/__media/video";

// Folders the user listed this session. Only video files directly inside them are served.
const allowedFolders = new Set<string>();

function isVideoFileName(name: string): boolean {
  return VIDEO_EXTENSIONS.has(NodePath.extname(name).toLowerCase());
}

/** Whether `file` is a video directly inside one of `folders`. */
export function isServableVideo(file: string, folders: ReadonlySet<string>): boolean {
  if (!NodePath.isAbsolute(file) || file.includes("\0") || !isVideoFileName(file)) return false;
  return folders.has(NodePath.dirname(NodePath.resolve(file)));
}

export async function listVideoFolder(
  folder: string,
): Promise<{ readonly folder: string; readonly files: ReadonlyArray<string> }> {
  if (!NodePath.isAbsolute(folder)) throw new Error("Choose a folder with a full path.");
  const resolved = NodePath.resolve(folder);
  const entries = await NodeFSP.readdir(resolved, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isVideoFileName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  allowedFolders.add(resolved);
  return { folder: resolved, files };
}

/** The file a media request asks for, or null when it may not be served. */
export function resolveMediaRequest(url: URL): string | null {
  if (url.pathname !== LOCAL_MEDIA_PATHNAME) return null;
  const file = url.searchParams.get("path");
  return file !== null && isServableVideo(file, allowedFolders) ? NodePath.resolve(file) : null;
}
