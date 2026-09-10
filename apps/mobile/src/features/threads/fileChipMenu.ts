import { fileBasename } from "@t3tools/client-runtime/markdown-links";
import type { ThreadId } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import type { MarkdownFileContextMenu } from "@t3tools/mobile-markdown-text/types";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";

export type FileChipAction = "copy-full-path" | "copy-relative-path" | "open-file" | "save";

export interface FileChipTarget {
  /** The host path, when the link is absolute or the workspace root is known. */
  readonly fullPath?: string;
  /** The path inside the workspace, when the link resolves there. */
  readonly relativePath?: string;
}

/** Null when the link is not a file or resolves nowhere the feed can open, such as `~/x` or `../x`. */
export function resolveFileChipTarget(
  href: string,
  workspaceRoot: string | null | undefined,
): FileChipTarget | null {
  const presentation = resolveMarkdownLinkPresentation(href);
  if (presentation.kind !== "file") return null;
  const relativePath = resolveWorkspaceRelativeFilePath(workspaceRoot, presentation.path);
  const fullPath = isAbsolutePath(presentation.path)
    ? presentation.path
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

/** Saving is available for the media and documents the host asset endpoint can serve. */
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
