import { splitPathAndPosition } from "./terminal-links";

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function canonicalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
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
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = normalizeAbsolutePath(path);
  let displayPath = normalizedPath;

  // Resolving dot segments is filesystem-dependent when an earlier segment is
  // a symlink. The browser does not own that filesystem (and it may be remote),
  // so preserve the authored absolute target instead of falsely claiming ./ or
  // ~/ containment.
  const canSafelyShorten =
    !hasDotPathSegment(path) && (!workspaceRoot || !hasDotPathSegment(workspaceRoot));

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

  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
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
  const { path, line, column } = splitPathAndPosition(pathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = canonicalizeWindowsDrivePath(
      normalizePathSeparators(trimTrailingPathSeparators(workspaceRoot)),
    );
    const workspaceLabel = basenameOfPath(normalizedWorkspaceRoot);
    const pathForCompare = normalizedPath.toLowerCase();
    const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${workspaceLabel.toLowerCase()}/`;

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

  if (!line) return displayPath;
  return `${displayPath}:${line}${column ? `:${column}` : ""}`;
}
