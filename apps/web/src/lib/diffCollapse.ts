export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

/** Expands or collapses all of `fileKeys`; every other file, such as a hidden one, keeps its fold. */
export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const collapse = !areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);
  const next = new Set(collapsedFileKeys);
  for (const fileKey of fileKeys) {
    if (collapse) next.add(fileKey);
    else next.delete(fileKey);
  }
  return next;
}
