import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { collectEditedFilePaths } from "@t3tools/client-runtime/state/thread-repositories";
import {
  fileBasename,
  isWindowsAbsolutePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";
import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import type { MarkdownFileContextMenu } from "../../native/SelectableMarkdownText.types";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

import {
  isAbsolutePath,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";

export interface FileChipTarget {
  readonly fullPath?: string;
  readonly relativePath?: string;
}

export function fileChipClipboardPath(
  target: FileChipTarget,
  action: "copy-full-path" | "copy-relative-path",
): string | undefined {
  const path = action === "copy-full-path" ? target.fullPath : target.relativePath;
  return path === undefined ? undefined : formatFilePathForClipboard(path, target.fullPath);
}

/** What a multi-repo thread's links can point at besides its cwd. */
export interface FileChipRepositories {
  /** Repo cwds and reference folders. */
  readonly roots: ReadonlyArray<string>;
  /** Absolute paths the thread's file changes reported, newest first. */
  readonly editedPaths: ReadonlyArray<string>;
}

const editedPathsByTurnItems = new WeakMap<
  ReadonlyArray<OrchestrationV2TurnItem>,
  ReadonlyArray<string>
>();

/** iOS builds a menu for every link of a message, so one scan serves them all. */
export function threadEditedFilePaths(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<string> {
  let paths = editedPathsByTurnItems.get(turnItems);
  if (paths === undefined) {
    paths = collectEditedFilePaths(turnItems);
    editedPathsByTurnItems.set(turnItems, paths);
  }
  return paths;
}

function joinParentRelativePath(cwd: string, relativePath: string): string | null {
  const segments = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const segment of relativePath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.length > 1) segments.pop();
    else return null;
  }
  return segments.join(isWindowsAbsolutePath(cwd) ? "\\" : "/");
}

function endsWithPath(path: string, suffix: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return isWindowsAbsolutePath(path)
    ? normalized.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)
    : normalized.endsWith(`/${suffix}`);
}

/**
 * Where a relative link points in a multi-repo thread, or null to join it with the thread's cwd:
 * a `../` path that lands in one of the thread's folders, else the newest file the thread edited
 * that ends with the path.
 */
export function resolveRepositoryFileLinkPath(
  linkPath: string,
  cwd: string | null | undefined,
  repositories: FileChipRepositories,
): string | null {
  const relativePath = linkPath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (relativePath.length === 0 || relativePath.startsWith("~/") || isAbsolutePath(relativePath)) {
    return null;
  }
  if (relativePath.startsWith("../")) {
    const joined = cwd ? joinParentRelativePath(cwd, relativePath) : null;
    return joined !== null &&
      repositories.roots.some((root) => workspaceRelativeFilePath(joined, root) !== null)
      ? joined
      : null;
  }
  return repositories.editedPaths.find((path) => endsWithPath(path, relativePath)) ?? null;
}

export function resolveFileChipTarget(
  href: string,
  workspaceRoot: string | null | undefined,
  repositories?: FileChipRepositories | null,
): FileChipTarget | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== "file") return null;
  const path =
    (repositories
      ? resolveRepositoryFileLinkPath(presentation.path, workspaceRoot, repositories)
      : null) ?? resolveFileLinkPath(workspaceRoot, presentation.path);
  if (path === null) return null;
  const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, path);
  const fullPath = isAbsolutePath(path)
    ? path
    : workspaceRoot && relativePath
      ? resolveWorkspaceFilePath(workspaceRoot, relativePath)
      : undefined;
  if (!fullPath && !relativePath) return null;
  return {
    ...(fullPath ? { fullPath } : {}),
    ...(relativePath ? { relativePath } : {}),
  };
}

function fileChipMetadata(target: FileChipTarget) {
  const path = target.fullPath ?? target.relativePath;
  if (!path) return null;
  const name = fileBasename(path);
  const dot = name.lastIndexOf(".");
  const mimeType = dot < 0 ? null : hostPreviewMimeTypeFromExtension(name.slice(dot));
  return mimeType ? { path, name, mimeType } : null;
}

/** Use literal resolved paths so encoded filename characters are not decoded twice. */
export function fileChipShareSource(target: FileChipTarget, threadId: ThreadId) {
  const metadata = fileChipMetadata(target);
  return metadata
    ? {
        name: metadata.name,
        mimeType: metadata.mimeType,
        resource: { _tag: "media-file" as const, threadId, path: metadata.path },
      }
    : null;
}

export function fileChipMenu(target: FileChipTarget): MarkdownFileContextMenu {
  return {
    title: target.fullPath ?? target.relativePath ?? "",
    actions: [
      ...(target.fullPath ? [{ id: "copy-full-path", title: "Copy full path" }] : []),
      ...(target.relativePath ? [{ id: "copy-relative-path", title: "Copy relative path" }] : []),
      { id: "open-file", title: "Open in file viewer" },
      ...(fileChipMetadata(target)
        ? [
            {
              id: "save",
              title: "Save or share",
            },
          ]
        : []),
    ],
  };
}
