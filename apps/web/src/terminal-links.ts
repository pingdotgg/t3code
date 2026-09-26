import {
  formatFilePathPosition,
  splitFilePathPosition,
} from "@t3tools/client-runtime/markdown-links";
import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/ghostty-terminal/terminal-links";

// Link detection lives with the terminal renderer; resolving a path against a
// workspace cwd is app behavior and stays here.
export {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isAbsolutePath,
  isTerminalLinkActivation,
  isTerminalUrl,
  type TerminalBufferLineLike,
  type TerminalLinkKind,
  type TerminalLinkMatch,
  type WrappedTerminalLinkLine,
  type WrappedTerminalLinkLineSegment,
} from "@t3tools/ghostty-terminal/terminal-links";

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const position = splitFilePathPosition(rawPath);
  const { path } = position;

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  return formatFilePathPosition({ ...position, path: resolvedPath });
}
