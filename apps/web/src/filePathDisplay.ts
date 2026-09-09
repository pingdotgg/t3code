import { pipe } from "effect/Function";
import {
  fileBasename,
  stripSlashPrefixedWindowsDrive,
  isWindowsAbsolutePath,
} from "@t3tools/shared/path";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function joinPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = stripSlashPrefixedWindowsDrive(normalizePathSeparators(position.path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = pipe(
      trimTrailingPathSeparators(workspaceRoot),
      normalizePathSeparators,
      stripSlashPrefixedWindowsDrive,
    );
    const workspaceLabel = fileBasename(normalizedWorkspaceRoot);
    const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
    const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const workspaceForCompare = caseInsensitive
      ? normalizedWorkspaceRoot.toLowerCase()
      : normalizedWorkspaceRoot;
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${caseInsensitive ? workspaceLabel.toLowerCase() : workspaceLabel}/`;

    if (pathForCompare === workspaceForCompare) {
      displayPath = workspaceLabel;
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = `${workspaceLabel}/${relativeSuffix}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  return formatFilePathPosition({ ...position, path: displayPath });
}

export function formatWorkspaceAbsolutePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = stripSlashPrefixedWindowsDrive(normalizePathSeparators(position.path));
  if (isAbsolutePath(normalizedPath) || !workspaceRoot) {
    return formatFilePathPosition({ ...position, path: normalizedPath });
  }

  const normalizedWorkspaceRoot = stripSlashPrefixedWindowsDrive(
    normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
  );
  const relativePath = stripRelativePrefixes(normalizedPath);
  const workspaceLabel = fileBasename(normalizedWorkspaceRoot);
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const relativeForCompare = caseInsensitive ? relativePath.toLowerCase() : relativePath;
  const workspaceLabelForCompare = caseInsensitive ? workspaceLabel.toLowerCase() : workspaceLabel;
  const includesWorkspaceLabel =
    relativeForCompare === workspaceLabelForCompare ||
    relativeForCompare.startsWith(`${workspaceLabelForCompare}/`);

  const workspaceParent = normalizedWorkspaceRoot.slice(
    0,
    Math.max(0, normalizedWorkspaceRoot.length - workspaceLabel.length - 1),
  );
  const absolutePath = includesWorkspaceLabel
    ? joinPath(workspaceParent, relativePath)
    : joinPath(normalizedWorkspaceRoot, relativePath);

  return formatFilePathPosition({ ...position, path: absolutePath });
}

export interface ResolvedChangedFilePath {
  readonly displayPath: string;
  readonly fullPath: string;
}

/**
 * Provider lifecycle events may report one changed file in both absolute and
 * workspace-relative forms. Resolve those forms before deduplicating them so
 * similarly named files outside the workspace remain distinct.
 */
export function resolveChangedFilePaths(
  paths: ReadonlyArray<string>,
  workspaceRoot: string | undefined,
): ResolvedChangedFilePath[] {
  const resolved = new Map<
    string,
    ResolvedChangedFilePath & { readonly sourceWasAbsolute: boolean }
  >();

  for (const pathWithPosition of paths) {
    const source = splitFilePathPosition(pathWithPosition);
    const normalizedSourcePath = stripSlashPrefixedWindowsDrive(
      normalizePathSeparators(source.path),
    );
    const fullPath = formatWorkspaceAbsolutePath(pathWithPosition, workspaceRoot);
    const fullPathWithoutPosition = splitFilePathPosition(fullPath).path;
    const caseInsensitive =
      isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(source.path)) ||
      (workspaceRoot !== undefined &&
        isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot)));
    const key = caseInsensitive ? fullPathWithoutPosition.toLowerCase() : fullPathWithoutPosition;
    const candidate = {
      displayPath: formatWorkspaceRelativePath(pathWithPosition, workspaceRoot),
      fullPath,
      sourceWasAbsolute: isAbsolutePath(normalizedSourcePath),
    };
    const existing = resolved.get(key);

    if (!existing) {
      resolved.set(key, candidate);
      continue;
    }

    resolved.set(key, {
      displayPath:
        candidate.displayPath.length < existing.displayPath.length
          ? candidate.displayPath
          : existing.displayPath,
      fullPath:
        candidate.sourceWasAbsolute && !existing.sourceWasAbsolute
          ? candidate.fullPath
          : existing.fullPath,
      sourceWasAbsolute: existing.sourceWasAbsolute || candidate.sourceWasAbsolute,
    });
  }

  return [...resolved.values()].map(({ displayPath, fullPath }) => ({ displayPath, fullPath }));
}
