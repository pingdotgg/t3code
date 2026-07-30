import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
} from "@t3tools/shared/path";
import { isWindowsPlatform } from "./utils";

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

function getAbsolutePathKind(value: string): "unix" | "windows" | null {
  if (isWindowsDrivePath(value) || isUncPath(value)) {
    return "windows";
  }

  if (value.startsWith("/")) {
    return "unix";
  }

  return null;
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }

  const trimmed =
    getAbsolutePathKind(value) === "unix"
      ? value.replace(/\/+$/g, "")
      : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }

  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

function preferredPathSeparator(value: string): "/" | "\\" {
  const absolutePathKind = getAbsolutePathKind(value);
  if (absolutePathKind === "windows") {
    return "\\";
  }
  if (absolutePathKind === "unix") {
    return "/";
  }

  return value.includes("\\") ? "\\" : "/";
}

export function hasTrailingPathSeparator(value: string): boolean {
  return (getAbsolutePathKind(value) === "unix" ? /\/$/ : /[\\/]$/).test(value);
}

export { isExplicitRelativePath as isExplicitRelativeProjectPath };

function splitPathSegments(value: string, separator: "/" | "\\"): string[] {
  return value.split(separator === "/" ? /\/+/ : /[\\/]+/).filter(Boolean);
}

function getLastPathSeparatorIndex(value: string): number {
  if (getAbsolutePathKind(value) === "unix") {
    return value.lastIndexOf("/");
  }

  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function splitAbsolutePath(value: string): {
  root: string;
  separator: "/" | "\\";
  segments: string[];
} | null {
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    const segments = splitPathSegments(value.slice(root.length), "\\");
    return { root, separator: "\\", segments };
  }
  if (isUncPath(value)) {
    const segments = splitPathSegments(value, "\\");
    const [server, share, ...rest] = segments;
    if (!server || !share) {
      return null;
    }
    return {
      root: `\\\\${server}\\${share}\\`,
      separator: "\\",
      segments: rest,
    };
  }
  if (value.startsWith("/")) {
    return {
      root: "/",
      separator: "/",
      segments: splitPathSegments(value.slice(1), "/"),
    };
  }
  return null;
}

export function isFilesystemBrowseQuery(
  value: string,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  const allowWindowsPaths = isWindowsPlatform(platform);
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    (allowWindowsPaths && isWindowsAbsolutePath(value))
  );
}

export function isUnsupportedWindowsProjectPath(value: string, platform: string): boolean {
  return isWindowsAbsolutePath(value) && !isWindowsPlatform(platform);
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativePath(trimmedValue) || !cwd) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const absoluteBase = splitAbsolutePath(normalizeProjectPathForDispatch(cwd));
  if (!absoluteBase) {
    return normalizeProjectPathForDispatch(trimmedValue);
  }

  const nextSegments = [...absoluteBase.segments];
  for (const segment of trimmedValue.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      nextSegments.pop();
      continue;
    }
    nextSegments.push(segment);
  }

  const joinedPath = nextSegments.join(absoluteBase.separator);
  if (joinedPath.length === 0) {
    return normalizeProjectPathForDispatch(absoluteBase.root);
  }

  return normalizeProjectPathForDispatch(`${absoluteBase.root}${joinedPath}`);
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || normalized.startsWith("\\\\")) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

export function findProjectByPath<T extends { cwd: string }>(
  projects: ReadonlyArray<T>,
  candidatePath: string,
): T | undefined {
  const normalizedCandidate = normalizeProjectPathForComparison(candidatePath);
  if (normalizedCandidate.length === 0) {
    return undefined;
  }

  return projects.find(
    (project) => normalizeProjectPathForComparison(project.cwd) === normalizedCandidate,
  );
}

export function inferProjectTitleFromPath(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  const absolutePath = splitAbsolutePath(normalized);
  if (absolutePath) {
    return absolutePath.segments.findLast(Boolean) ?? normalized;
  }

  const segments = normalized.split(/[/\\]/);
  return segments.findLast(Boolean) ?? normalized;
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
  const separator = preferredPathSeparator(currentPath);
  return `${getBrowseDirectoryPath(currentPath)}${segment}${separator}`;
}

export function getBrowseLeafPathSegment(currentPath: string): string {
  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  return currentPath.slice(lastSeparatorIndex + 1);
}

export function getBrowseDirectoryPath(currentPath: string): string {
  if (hasTrailingPathSeparator(currentPath)) {
    return currentPath;
  }

  const lastSeparatorIndex = getLastPathSeparatorIndex(currentPath);
  if (lastSeparatorIndex < 0) {
    return currentPath;
  }

  return currentPath.slice(0, lastSeparatorIndex + 1);
}

export function ensureBrowseDirectoryPath(currentPath: string): string {
  const trimmed = currentPath.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  if (hasTrailingPathSeparator(trimmed)) {
    return trimmed;
  }

  return `${trimmed}${preferredPathSeparator(trimmed)}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const trimmed = trimTrailingPathSeparators(currentPath);
  const absolutePath = splitAbsolutePath(trimmed);
  if (absolutePath) {
    if (absolutePath.segments.length === 0) {
      return null;
    }

    if (absolutePath.segments.length === 1) {
      return absolutePath.root;
    }

    const parentSegments = absolutePath.segments.slice(0, -1).join(absolutePath.separator);
    return `${absolutePath.root}${parentSegments}${absolutePath.separator}`;
  }

  const separator = preferredPathSeparator(currentPath);
  const lastSeparatorIndex = getLastPathSeparatorIndex(trimmed);

  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 2 && /^[a-zA-Z]:/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}${separator}`;
  }

  return trimmed.slice(0, lastSeparatorIndex + 1);
}

export function canNavigateUp(currentPath: string): boolean {
  return hasTrailingPathSeparator(currentPath) && getBrowseParentPath(currentPath) !== null;
}
