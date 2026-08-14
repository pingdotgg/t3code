import { resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";

export interface ComposerMentionFileTarget {
  readonly relativePath: string;
  readonly line?: number;
}

function toPosixPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  // Windows drive paths pick up a leading slash on the way through URL-ish
  // plumbing (`/C:/repo`); the workspace root never carries one.
  return /^\/[A-Za-z]:\//.test(normalized) ? normalized.slice(1) : normalized;
}

const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\//;

function collapseDotSegments(path: string): string {
  const isAbsolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }
      // `/..` is `/`; a surviving `..` would walk out of the workspace.
      if (isAbsolute) continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

/** Null for anything outside the workspace, which leaves the chip inert. */
export function resolveComposerMentionFileTarget(
  mentionPath: string,
  workspaceRoot: string | undefined,
): ComposerMentionFileTarget | null {
  const trimmed = mentionPath.trim();
  if (!trimmed || !workspaceRoot) return null;

  const { path, line } = splitPathAndPosition(trimmed);
  if (!path) return null;

  const absolute = collapseDotSegments(toPosixPath(resolvePathLinkTarget(path, workspaceRoot)));
  const normalizedRoot = collapseDotSegments(toPosixPath(workspaceRoot));
  // A `/` root strips to an empty prefix, which is what makes `/x` read as `x`.
  const root = normalizedRoot === "/" ? "" : normalizedRoot.replace(/\/+$/, "");
  if (!root && normalizedRoot !== "/") return null;
  // Compared the way the root's filesystem would: exact for POSIX, folded for
  // a Windows drive.
  const rootIsCaseInsensitive = WINDOWS_DRIVE_ROOT_PATTERN.test(normalizedRoot);
  const comparableAbsolute = rootIsCaseInsensitive ? absolute.toLowerCase() : absolute;
  const comparableRoot = rootIsCaseInsensitive ? root.toLowerCase() : root;
  if (!comparableAbsolute.startsWith(`${comparableRoot}/`)) return null;

  const relativePath = absolute.slice(root.length + 1);
  if (!relativePath) return null;

  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  return Number.isFinite(parsedLine) ? { relativePath, line: parsedLine } : { relativePath };
}
