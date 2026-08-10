import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

import { resolveMarkdownFileLinkMeta } from "./markdown-links";

export interface MarkdownImageFile {
  readonly path: string;
  readonly name: string;
}

export function resolveMarkdownImageFile(
  src: string | undefined,
  cwd: string | undefined,
): MarkdownImageFile | null {
  const fileLinkMeta = resolveMarkdownFileLinkMeta(src, cwd);
  if (!fileLinkMeta || !isWorkspaceImagePreviewPath(fileLinkMeta.filePath)) {
    return null;
  }
  return { path: fileLinkMeta.filePath, name: fileLinkMeta.basename };
}
