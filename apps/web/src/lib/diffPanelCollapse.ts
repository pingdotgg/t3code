import type { FileDiffMetadata } from "@pierre/diffs/react";

export function resolveFileDiffPath(fileDiff: Pick<FileDiffMetadata, "name" | "prevName">): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

export function buildFileDiffRenderKey(
  fileDiff: Pick<FileDiffMetadata, "cacheKey" | "name" | "prevName">,
): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

export function toggleCollapsedDiffFile(
  current: ReadonlySet<string>,
  fileKey: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(fileKey)) {
    next.delete(fileKey);
  } else {
    next.add(fileKey);
  }
  return next;
}

export function resetCollapsedDiffFiles(): ReadonlySet<string> {
  return new Set<string>();
}

export function expandCollapsedDiffFileForPath(
  current: ReadonlySet<string>,
  files: ReadonlyArray<Pick<FileDiffMetadata, "cacheKey" | "name" | "prevName">>,
  filePath: string,
): ReadonlySet<string> {
  const match = files.find((fileDiff) => resolveFileDiffPath(fileDiff) === filePath);
  if (!match) {
    return current;
  }

  const fileKey = buildFileDiffRenderKey(match);
  if (!current.has(fileKey)) {
    return current;
  }

  const next = new Set(current);
  next.delete(fileKey);
  return next;
}
