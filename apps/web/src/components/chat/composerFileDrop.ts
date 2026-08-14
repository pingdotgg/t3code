import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/**
 * Split files from an OS drag-and-drop into the two ways the composer can use
 * them: images become inline attachments, everything else becomes a file
 * mention that points the agent at the dropped path.
 */
export interface DroppedComposerFilePartition {
  readonly imageFiles: File[];
  readonly pathFiles: File[];
}

export function partitionDroppedComposerFiles(
  files: readonly File[],
): DroppedComposerFilePartition {
  const imageFiles: File[] = [];
  const pathFiles: File[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      pathFiles.push(file);
    }
  }
  return { imageFiles, pathFiles };
}

/**
 * Convert an absolute filesystem path into the value inserted as a composer
 * mention. When the path lives inside the workspace cwd it is made
 * workspace-relative so it matches typed and file-tree mentions; otherwise the
 * absolute path is kept so the reference is still unambiguous.
 *
 * Path separators are normalised to `/` so Windows drops relativise too. The
 * prefix comparison is case-sensitive, so a drop that differs only in casing
 * from the cwd (possible on case-insensitive volumes) keeps its absolute path
 * rather than guessing a relative one.
 */
export function toComposerMentionPath(absolutePath: string, cwd: string | null): string {
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  if (cwd !== null) {
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedCwd.length > 0) {
      const prefix = `${normalizedCwd}/`;
      if (normalizedPath.startsWith(prefix) && normalizedPath.length > prefix.length) {
        return normalizedPath.slice(prefix.length);
      }
    }
  }
  return normalizedPath;
}

/**
 * Build the composer text for a set of dropped file paths: one serialized file
 * link per path, space-separated so each stays a valid mention token.
 */
export function buildDroppedFileMentions(paths: readonly string[], cwd: string | null): string {
  return paths.map((path) => serializeComposerFileLink(toComposerMentionPath(path, cwd))).join(" ");
}
