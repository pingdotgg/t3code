import {
  fileBasename,
  formatFilePathPosition,
  splitFilePathPosition,
  stripSlashPrefixedWindowsDrive,
} from "@t3tools/client-runtime/markdown-links";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = stripSlashPrefixedWindowsDrive(normalizePathSeparators(path));
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function hasDotPathSegment(path: string): boolean {
  return normalizePathSeparators(path)
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function homeDirectoryFromWorkspace(workspaceRoot: string): string | undefined {
  if (workspaceRoot === "/root" || workspaceRoot.startsWith("/root/")) return "/root";
  const wslShare = workspaceRoot.match(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+/i)?.[0];
  if (wslShare) {
    const linuxPath = workspaceRoot.slice(wslShare.length);
    const linuxHome =
      linuxPath.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ?? linuxPath.match(/^\/root(?=\/|$)/)?.[0];
    if (linuxHome) return `${wslShare}${linuxHome}`;
  }
  return (
    workspaceRoot.match(/^\/Users\/[^/]+/)?.[0] ??
    workspaceRoot.match(/^\/home\/[^/]+/)?.[0] ??
    workspaceRoot.match(/^[A-Za-z]:\/Users\/[^/]+/i)?.[0]
  );
}

function comparisonPath(path: string): string {
  // Drive-letter paths are owned by Windows. UNC paths may instead point at a
  // case-sensitive WSL or SMB backend, so an exact-case match is the only safe
  // browser-side containment claim for them.
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function suffixWithin(path: string, parent: string): string | null {
  const comparablePath = comparisonPath(path);
  const comparableParent = comparisonPath(parent);
  if (comparablePath === comparableParent) return "";
  const parentWithSeparator = parent.endsWith("/") ? parent : `${parent}/`;
  const comparablePrefix = comparisonPath(parentWithSeparator);
  return comparablePath.startsWith(comparablePrefix)
    ? path.slice(parentWithSeparator.length)
    : null;
}

export function formatCompactFilePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = normalizeAbsolutePath(position.path);
  let displayPath = normalizedPath;

  // Resolving dot segments is filesystem-dependent when an earlier segment is
  // a symlink. The browser does not own that filesystem (and it may be remote),
  // so preserve the authored absolute target instead of falsely claiming ./ or
  // ~/ containment.
  const canSafelyShorten =
    !hasDotPathSegment(position.path) && (!workspaceRoot || !hasDotPathSegment(workspaceRoot));

  if (workspaceRoot && canSafelyShorten) {
    const normalizedWorkspaceRoot = normalizeAbsolutePath(workspaceRoot);
    const workspaceSuffix = suffixWithin(normalizedPath, normalizedWorkspaceRoot);
    if (workspaceSuffix !== null) {
      displayPath = workspaceSuffix ? `./${workspaceSuffix}` : "./";
    } else {
      const homeDirectory = homeDirectoryFromWorkspace(normalizedWorkspaceRoot);
      const homeSuffix = homeDirectory ? suffixWithin(normalizedPath, homeDirectory) : null;
      if (homeSuffix !== null) {
        displayPath = homeSuffix ? `~/${homeSuffix}` : "~/";
      }
    }
  }

  return formatFilePathPosition({ ...position, path: displayPath });
}

export function formatFileChipLabel(input: {
  readonly showFileLinkPaths: boolean;
  readonly targetPath: string;
  readonly workspaceRoot: string | undefined;
  readonly basename: string;
  readonly parentSuffix?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
}): string {
  if (input.showFileLinkPaths) {
    return formatCompactFilePath(input.targetPath, input.workspaceRoot);
  }

  const labelParts = [input.basename];
  if (input.parentSuffix) labelParts.push(input.parentSuffix);
  if (input.line) {
    labelParts.push(`L${input.line}${input.column ? `:C${input.column}` : ""}`);
  }
  return labelParts.join(" · ");
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = stripSlashPrefixedWindowsDrive(normalizePathSeparators(position.path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = stripSlashPrefixedWindowsDrive(
      normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
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
