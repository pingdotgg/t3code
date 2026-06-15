import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
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

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export function resolveFilePreviewPath(filePathWithPosition: string, cwd: string): string | null {
  const { path } = splitPathAndPosition(filePathWithPosition);
  const normalizedPath = canonicalizeWindowsDrivePath(normalizePathSeparators(path));
  const normalizedCwd = canonicalizeWindowsDrivePath(
    normalizePathSeparators(trimTrailingPathSeparators(cwd)),
  );
  const pathForCompare = normalizedPath.toLowerCase();
  const cwdForCompare = normalizedCwd.toLowerCase();

  if (pathForCompare === cwdForCompare) {
    return null;
  }
  if (pathForCompare.startsWith(`${cwdForCompare}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }
  if (!isAbsolutePath(normalizedPath)) {
    return stripRelativePrefixes(normalizedPath);
  }
  return null;
}

export function openFileInFilePreview(
  threadRef: ScopedThreadRef,
  filePath: string,
  cwd: string,
): void {
  const previewPath = resolveFilePreviewPath(filePath, cwd);
  if (!previewPath) {
    throw new Error("File is outside the active workspace.");
  }
  useRightPanelStore.getState().openFilePreview(threadRef, previewPath);
}
