import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { fileBasename } from "@t3tools/shared/path";
import type { ThreadId } from "@t3tools/contracts";
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

export function resolveFileChipTarget(
  href: string,
  workspaceRoot: string | null | undefined,
): FileChipTarget | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== "file") return null;
  const path = resolveFileLinkPath(workspaceRoot, presentation.path);
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
