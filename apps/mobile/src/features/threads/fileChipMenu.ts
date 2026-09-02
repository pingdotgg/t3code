import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import type { MarkdownFileContextMenu } from "@t3tools/mobile-markdown-text/types";

import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  resolveWorkspaceRelativeFilePath,
} from "../files/filePath";

export type FileChipAction = "copy-full-path" | "copy-relative-path" | "open-file";

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

/** The same actions the web file chip offers on right-click. Opening is what a tap does. */
export function fileChipMenu(target: FileChipTarget): MarkdownFileContextMenu {
  return {
    title: target.fullPath ?? target.relativePath ?? "",
    actions: [
      ...(target.fullPath ? [{ id: "copy-full-path", title: "Copy full path" }] : []),
      ...(target.relativePath ? [{ id: "copy-relative-path", title: "Copy relative path" }] : []),
      { id: "open-file", title: "Open in file viewer" },
    ],
  };
}
