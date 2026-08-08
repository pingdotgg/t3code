import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/**
 * The subset of File the drop partition reads. Kept structural so the pure
 * logic is testable without constructing DOM File objects.
 */
export interface DroppedFileLike {
  readonly name: string;
  readonly type: string;
}

export interface DroppedComposerFilePartition<T extends DroppedFileLike> {
  /** Files routed to the existing image-attachment flow. */
  readonly imageFiles: T[];
  /** Prompt text (trailing space included) for path mentions, or null. */
  readonly mentionText: string | null;
  /** Non-image files whose on-disk path could not be resolved. */
  readonly unresolvedFileNames: string[];
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * A desktop renderer can only hand an agent host paths when the selected
 * environment is the primary backend on that same host. Saved remotes, SSH,
 * relays, and desktop-local WSL backends have different filesystems.
 */
export function canResolveComposerHostFilePaths(
  targetTag: ConnectionTarget["_tag"] | null,
): boolean {
  return targetTag === "PrimaryConnectionTarget";
}

/**
 * A resolved host path is only meaningful when the renderer and the selected
 * environment share a filesystem, which the connection target alone cannot
 * establish: in desktop WSL-only mode the primary slot is a Linux server on a
 * Windows host, so getPathForFile yields Windows paths the agent cannot read.
 * Mismatched path styles are rejected rather than translated because WSL
 * mount roots are configurable, and a guessed /mnt/c/... path would silently
 * point the agent at a nonexistent file.
 */
export function hostPathUsableOnPlatform(
  absolutePath: string,
  environmentOs: ExecutionEnvironmentPlatformOs | null,
): boolean {
  if (environmentOs === null || environmentOs === "unknown") return true;
  return isWindowsAbsolutePath(absolutePath) === (environmentOs === "windows");
}

/**
 * Relativize an OS path against the workspace root, or null when the path is
 * outside it. Windows paths compare case-insensitively; POSIX paths preserve
 * case so Linux workspaces cannot accidentally resolve to a different file.
 * Backslashes count as separators only in Windows paths; on POSIX they are
 * valid filename characters and pass through untouched.
 */
export function workspaceRelativeDropPath(
  absolutePath: string,
  workspaceRoot: string | null,
): string | null {
  if (workspaceRoot === null || workspaceRoot.length === 0) return null;
  const isWindows = isWindowsAbsolutePath(absolutePath) && isWindowsAbsolutePath(workspaceRoot);
  // A filesystem-root workspace ("/") trims to an empty string here; the
  // separator appended for the prefix check below restores it.
  const normalizedRoot = (
    isWindows ? normalizePathSeparators(workspaceRoot) : workspaceRoot
  ).replace(/\/+$/, "");
  const normalizedPath = isWindows ? normalizePathSeparators(absolutePath) : absolutePath;
  const comparableRoot = isWindows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparablePath = isWindows ? normalizedPath.toLowerCase() : normalizedPath;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) return null;
  // Slice by the original root's length, not the comparable prefix's:
  // lowercasing can change string length for some Unicode (e.g. "İ"), and a
  // mismatched offset must fall back to the absolute path, so require the
  // boundary in the original path to be the separator itself.
  if (normalizedPath[normalizedRoot.length] !== "/") return null;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  return relativePath.length > 0 ? relativePath : null;
}

/**
 * The path a dropped or pasted OS file should be mentioned by:
 * workspace-relative when inside the workspace, the absolute path otherwise
 * (separator-normalized only when it is a Windows path).
 */
export function composerMentionPathFromAbsolute(
  absolutePath: string,
  workspaceRoot: string | null,
): string {
  return (
    workspaceRelativeDropPath(absolutePath, workspaceRoot) ??
    (isWindowsAbsolutePath(absolutePath) ? normalizePathSeparators(absolutePath) : absolutePath)
  );
}

/**
 * Split an OS file drop: images keep the attachment flow, everything else
 * becomes a path mention (workspace-relative when the file lives inside the
 * workspace) so the agent can read the file where it already is. Files whose
 * path cannot be resolved (browser builds have no OS path access) are
 * reported by name for the caller to surface.
 */
export function partitionDroppedComposerFiles<T extends DroppedFileLike>(
  files: ReadonlyArray<T>,
  resolvePath: (file: T) => string | null,
  workspaceRoot: string | null,
): DroppedComposerFilePartition<T> {
  const imageFiles: T[] = [];
  const mentions: string[] = [];
  const unresolvedFileNames: string[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
      continue;
    }
    const absolutePath = resolvePath(file);
    if (absolutePath === null || absolutePath.length === 0) {
      unresolvedFileNames.push(file.name);
      continue;
    }
    mentions.push(
      serializeComposerFileLink(composerMentionPathFromAbsolute(absolutePath, workspaceRoot)),
    );
  }
  return {
    imageFiles,
    mentionText: mentions.length > 0 ? `${mentions.join(" ")} ` : null,
    unresolvedFileNames,
  };
}

/**
 * Resolve the on-disk path of an OS-dropped File via the desktop bridge.
 * Returns null outside the desktop shell (browsers expose no OS path) and on
 * shells predating the bridge method.
 */
export function resolveOsDroppedFilePath(file: File): string | null {
  if (typeof window === "undefined") return null;
  const getPathForFile = window.desktopBridge?.getPathForFile;
  if (getPathForFile === undefined) return null;
  try {
    const path = getPathForFile(file);
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}
