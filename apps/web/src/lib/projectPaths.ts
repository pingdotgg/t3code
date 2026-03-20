import { isWindowsPlatform } from "./utils";

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

function isRootPath(value: string): boolean {
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]?$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }

  const trimmed = value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }

  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

function preferredPathSeparator(value: string): "/" | "\\" {
  return value.includes("\\") ? "\\" : "/";
}

function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isExplicitRelativeProjectPath(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

function splitAbsolutePath(value: string): {
  root: string;
  separator: "/" | "\\";
  segments: string[];
} | null {
  const separator = preferredPathSeparator(value);
  if (isWindowsDrivePath(value)) {
    const root = `${value.slice(0, 2)}\\`;
    const segments = value
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean);
    return { root, separator: "\\", segments };
  }
  if (isUncPath(value)) {
    const segments = value.split(/[\\/]+/).filter(Boolean);
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
      separator,
      segments: value
        .slice(1)
        .split(/[\\/]+/)
        .filter(Boolean),
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
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    (allowWindowsPaths && (value.startsWith("\\\\") || isWindowsDrivePath(value)))
  );
}

export function isUnsupportedWindowsProjectPath(value: string, platform: string): boolean {
  return (isWindowsDrivePath(value) || isUncPath(value)) && !isWindowsPlatform(platform);
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function resolveProjectPathForDispatch(value: string, cwd?: string | null): string {
  const trimmedValue = value.trim();
  if (!isExplicitRelativeProjectPath(trimmedValue) || !cwd) {
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
  const segments = normalized.split(/[/\\]/);
  return segments.findLast(Boolean) ?? normalized;
}

export function appendBrowsePathSegment(currentPath: string, segment: string): string {
  const separator = preferredPathSeparator(currentPath);
  const parentPath = currentPath.replace(/[^/\\]*$/, "");
  return `${parentPath}${segment}${separator}`;
}

export function getBrowseParentPath(currentPath: string): string | null {
  const separator = preferredPathSeparator(currentPath);
  const trimmed = currentPath.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 2 && /^[a-zA-Z]:/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}${separator}`;
  }

  return trimmed.slice(0, lastSeparatorIndex + 1);
}
