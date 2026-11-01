import { buildWslOpenUrl, type EditorId } from "@t3tools/contracts";
import { formatFilePathPosition, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import type { MarkdownFileLinkMeta } from "./markdown-links";

interface MarkdownFileHostPath {
  absolutePath: string;
  matched: boolean;
}

export async function resolveMarkdownFileHostPath(input: {
  meta: MarkdownFileLinkMeta;
  cwd: string | undefined;
  findWorkspaceMatch: (workspaceRelativePath: string) => Promise<string | null>;
}) {
  const { meta, cwd } = input;
  const match =
    meta.workspaceLookupPath && cwd
      ? await input.findWorkspaceMatch(meta.workspaceLookupPath)
      : null;
  return match && cwd
    ? { absolutePath: resolvePathLinkTarget(match, cwd), matched: true }
    : { absolutePath: meta.filePath, matched: false };
}

export function markdownFileEditorTarget(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
) {
  return hostPath.matched
    ? formatFilePathPosition({ ...meta, path: hostPath.absolutePath })
    : meta.targetPath;
}

export function markdownFileCopyPaths(
  meta: MarkdownFileLinkMeta,
  hostPath: MarkdownFileHostPath,
  cwd: string | undefined,
) {
  const fullPath = markdownFileEditorTarget(meta, hostPath);
  return {
    fullPath,
    relativePath: formatFilePathPosition({
      ...meta,
      path: workspaceRelativeFilePath(hostPath.absolutePath, cwd) ?? meta.filePath,
    }),
  };
}

export function buildWslMarkdownFileUrl(input: {
  editor: EditorId;
  distro: string;
  path: string;
  cwd: string | undefined;
  line: number | undefined;
  column: number | undefined;
}) {
  const path = input.cwd ? resolvePathLinkTarget(input.path, input.cwd) : input.path;
  const segments: string[] = [];
  if (path.startsWith("/") && !path.includes("\\")) {
    for (const segment of path.split("/")) {
      if (segment === "..") return undefined;
      else if (segment !== "" && segment !== ".") segments.push(segment);
    }
  }
  return buildWslOpenUrl({
    editor: input.editor,
    distro: input.distro,
    absolutePath: path.startsWith("/") && !path.includes("\\") ? `/${segments.join("/")}` : path,
    isFile: true,
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
  });
}
