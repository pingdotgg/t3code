import { isWindowsAbsolutePath } from "@forma/shared/path";
import { resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";

export interface WorkspaceEditorTarget {
  relativePath: string;
  line?: number;
  column?: number;
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

function normalizeSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingSeparators(path: string): string {
  if (path === "/") {
    return path;
  }
  if (/^[A-Za-z]:\/$/.test(path)) {
    return path;
  }
  return path.replace(/\/+$/, "");
}

function normalizeAbsolutePath(path: string): string {
  return trimTrailingSeparators(normalizeSeparators(canonicalizeWindowsDrivePath(path.trim())));
}

function normalizeRelativePath(path: string): string {
  return normalizeSeparators(path).replace(/^\.\/+/, "");
}

export function resolveWorkspaceEditorTarget(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): WorkspaceEditorTarget | null {
  if (!workspaceRoot) {
    return null;
  }

  const normalizedWorkspaceRoot = normalizeAbsolutePath(workspaceRoot);
  if (normalizedWorkspaceRoot.length === 0) {
    return null;
  }

  const resolvedTarget = resolvePathLinkTarget(pathWithPosition.trim(), normalizedWorkspaceRoot);
  const { path, line, column } = splitPathAndPosition(resolvedTarget);
  const normalizedAbsolutePath = normalizeAbsolutePath(path);
  if (normalizedAbsolutePath.length === 0 || normalizedAbsolutePath === normalizedWorkspaceRoot) {
    return null;
  }

  const windowsPath =
    isWindowsAbsolutePath(normalizedWorkspaceRoot) || isWindowsAbsolutePath(normalizedAbsolutePath);
  const comparableWorkspaceRoot = windowsPath
    ? normalizedWorkspaceRoot.toLowerCase()
    : normalizedWorkspaceRoot;
  const comparableAbsolutePath = windowsPath
    ? normalizedAbsolutePath.toLowerCase()
    : normalizedAbsolutePath;
  const rootPrefix =
    comparableWorkspaceRoot === "/" ? comparableWorkspaceRoot : `${comparableWorkspaceRoot}/`;
  if (!comparableAbsolutePath.startsWith(rootPrefix)) {
    return null;
  }

  const relativeStartIndex =
    normalizedWorkspaceRoot === "/" ? 1 : normalizedWorkspaceRoot.length + 1;
  const relativePath = normalizeRelativePath(normalizedAbsolutePath.slice(relativeStartIndex));
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    return null;
  }

  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;

  return {
    relativePath,
    ...(Number.isFinite(parsedLine) ? { line: parsedLine } : {}),
    ...(Number.isFinite(parsedColumn) ? { column: parsedColumn } : {}),
  };
}
