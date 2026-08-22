const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string }
  | { readonly _tag: "Blocked" };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSource(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

function normalizeWindowsDrivePath(value: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(value) ? value.slice(1) : value;
}

function parseFileUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    if (parsed.hostname.length > 0 && parsed.hostname.toLowerCase() !== "localhost") {
      const pathname = safeDecode(parsed.pathname).replaceAll("/", "\\");
      return `\\\\${safeDecode(parsed.hostname)}${pathname}`;
    }

    const pathname = safeDecode(parsed.pathname);
    if (pathname.length === 0) return null;
    return normalizeWindowsDrivePath(pathname);
  } catch {
    return null;
  }
}

function stripSearchAndHash(value: string): string {
  const searchIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const end = [searchIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length);
  return value.slice(0, end);
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const windows =
    WINDOWS_DRIVE_PATH_PATTERN.test(workspaceRoot) || workspaceRoot.startsWith("\\\\");
  const separator = windows ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/**
 * Classifies a markdown image source by where its bytes must be loaded from.
 * Filesystem paths belong to the environment host and must never reach a
 * browser or native image component without first becoming a signed asset URL.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };

  const source = normalizeSource(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) {
    return { _tag: "Blocked" };
  }
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) {
    return { _tag: "Direct", uri: source };
  }

  if (/^file:/i.test(source)) {
    const path = parseFileUrl(source);
    return path === null ? { _tag: "Blocked" } : { _tag: "WorkspaceFile", path };
  }

  const path = normalizeWindowsDrivePath(safeDecode(stripSearchAndHash(source)));
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || WINDOWS_DRIVE_PATH_PATTERN.test(path) || path.startsWith("\\\\")) {
    return { _tag: "WorkspaceFile", path };
  }
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return { _tag: "Blocked" };
  }
  if (!workspaceRoot) return { _tag: "Blocked" };

  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path) };
}
