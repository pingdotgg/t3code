import path from "node:path";

export interface ParsedWslUncPath {
  readonly distroName: string;
  readonly path: string;
}

const WSL_UNC_PREFIX = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\/]+)(?:[\\/](.*))?$/i;

export function parseWslUncPath(input: string): ParsedWslUncPath | null {
  const match = input.match(WSL_UNC_PREFIX);
  if (!match) return null;
  const distroName = match[1]?.trim();
  if (!distroName) return null;
  const rest = match[2]?.replaceAll("\\", "/") ?? "";
  return {
    distroName,
    path: `/${rest}`.replace(/\/+/g, "/"),
  };
}

export function windowsPathToMntPath(input: string): string | null {
  const parsed = path.win32.parse(input);
  const drive = parsed.root.match(/^([A-Za-z]):\\$/)?.[1]?.toLowerCase();
  if (!drive) return null;
  const relative = path.win32.relative(parsed.root, path.win32.resolve(input));
  const posixRelative = relative.split(path.win32.sep).filter(Boolean).join("/");
  return posixRelative ? `/mnt/${drive}/${posixRelative}` : `/mnt/${drive}`;
}

export function isUnsupportedNetworkPath(input: string): boolean {
  return input.startsWith("\\\\") && parseWslUncPath(input) === null;
}

export function normalizePosixPath(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function resolvePosixChild(root: string, relativePath: string): string | null {
  const normalizedRoot = normalizePosixPath(root);
  const resolved = path.posix.resolve(normalizedRoot, relativePath);
  if (resolved === normalizedRoot) {
    return null;
  }
  if (normalizedRoot === "/") {
    return resolved;
  }
  if (resolved.startsWith(`${normalizedRoot}/`)) {
    return resolved;
  }
  return null;
}
