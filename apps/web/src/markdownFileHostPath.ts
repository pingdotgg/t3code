/**
 * Where a chat file chip's file really is on the environment host. A bare
 * filename (`user.ts`) resolves against the workspace root, which is rarely
 * where it lives, so the workspace index is asked first, as the files panel
 * does. Open in editor, reveal and the copy actions all go through here so
 * they agree on one file.
 */
import { formatFilePathPosition, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import type { MarkdownFileLinkMeta } from "./markdown-links";

export interface MarkdownFileHostPath {
  /** Absolute host path, without a line/column suffix. */
  readonly absolutePath: string;
  /** Whether the workspace index moved the link to a different file. */
  readonly matched: boolean;
}

export async function resolveMarkdownFileHostPath(input: {
  readonly meta: MarkdownFileLinkMeta;
  readonly cwd: string | undefined;
  /** The workspace-relative file the reference names, or null when not found. */
  readonly findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
}): Promise<MarkdownFileHostPath> {
  const { meta, cwd } = input;
  const match =
    meta.workspaceRelativePath && cwd
      ? await input.findWorkspaceMatch(meta.workspaceRelativePath)
      : null;
  if (match && cwd) {
    return { absolutePath: resolvePathLinkTarget(match, cwd), matched: true };
  }
  return { absolutePath: meta.filePath, matched: false };
}

/** The editor target for a resolved chip, keeping the link's line and column. */
export function markdownFileEditorTarget(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
): string {
  if (!hostPath.matched) return meta.targetPath;
  return formatFilePathPosition({
    path: hostPath.absolutePath,
    ...(meta.line !== undefined ? { line: meta.line } : {}),
    ...(meta.column !== undefined ? { column: meta.column } : {}),
  });
}

/** What the chip's Copy full path and Copy relative path put on the clipboard. */
export function markdownFileCopyPaths(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
  cwd: string | undefined,
): { readonly fullPath: string; readonly relativePath: string } {
  if (!hostPath.matched) return { fullPath: meta.targetPath, relativePath: meta.displayPath };
  const fullPath = markdownFileEditorTarget(meta, hostPath);
  return { fullPath, relativePath: formatWorkspaceRelativePath(fullPath, cwd) };
}
