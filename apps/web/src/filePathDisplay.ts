import {
  isWindowsAbsolutePath,
  normalizePathCaseForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";

import { splitPathAndPosition } from "./terminal-links";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function isForwardSlashUncPath(path: string): boolean {
  return /^\/\/[^/]/.test(path);
}

function isCaseInsensitiveWorkspacePath(path: string): boolean {
  return isWindowsAbsolutePath(path) || isForwardSlashUncPath(path);
}

function normalizeWorkspacePathForComparison(path: string): string {
  const canonicalPath = isForwardSlashUncPath(path) ? path.replaceAll("/", "\\") : path;
  return normalizePathCaseForComparison(canonicalPath);
}

function basenameOfPath(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path.slice(0, 2);
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export function resolveWorkspaceRelativePath(path: string, workspaceRoot: string): string | null {
  const normalizedPath = canonicalizeWindowsDrivePath(path);
  const normalizedRoot = canonicalizeWindowsDrivePath(
    normalizeProjectPathForDispatch(workspaceRoot),
  );
  const pathForCompare = normalizeWorkspacePathForComparison(normalizedPath);
  const rootForCompare = normalizeWorkspacePathForComparison(normalizedRoot);

  if (pathForCompare === rootForCompare) return "";

  const separator = isCaseInsensitiveWorkspacePath(normalizedRoot) ? "\\" : "/";
  const rootPrefix = rootForCompare.endsWith(separator)
    ? rootForCompare
    : `${rootForCompare}${separator}`;
  if (!pathForCompare.startsWith(rootPrefix)) return null;

  const relativeStart =
    normalizedRoot.endsWith("/") || normalizedRoot.endsWith("\\")
      ? normalizedRoot.length
      : normalizedRoot.length + 1;
  return normalizePathSeparators(normalizedPath.slice(relativeStart));
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const canonicalPath = canonicalizeWindowsDrivePath(path);
  const normalizedPath = normalizePathSeparators(canonicalPath);

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const canonicalWorkspaceRoot = canonicalizeWindowsDrivePath(
      normalizeProjectPathForDispatch(workspaceRoot),
    );
    const normalizedWorkspaceRoot = normalizePathSeparators(canonicalWorkspaceRoot);
    const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
    const workspaceRelativePath = resolveWorkspaceRelativePath(path, workspaceRoot);
    const caseInsensitive = isCaseInsensitiveWorkspacePath(canonicalWorkspaceRoot);
    const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const workspaceLabelForCompare = caseInsensitive
      ? workspaceLabel.toLowerCase()
      : workspaceLabel;
    const workspaceLabelWithSeparator = `${workspaceLabelForCompare}/`;

    if (workspaceRelativePath === "") {
      displayPath =
        normalizedWorkspaceRoot === "/" || /^[A-Za-z]:\/$/.test(normalizedWorkspaceRoot)
          ? normalizedWorkspaceRoot
          : workspaceLabel;
    } else if (workspaceRelativePath !== null) {
      displayPath = `${workspaceLabel}/${workspaceRelativePath}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
}
