const IGNORED_WORKSPACE_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

export function isPathInIgnoredWorkspaceDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) {
    return false;
  }

  return IGNORED_WORKSPACE_DIRECTORY_NAMES.has(firstSegment);
}
