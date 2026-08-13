export interface FileTreeSelectionEntry {
  readonly treePath: string;
  readonly relativePath: string;
  readonly root?: string;
}

export function resolveFileTreeSelectionPath(
  entries: ReadonlyArray<FileTreeSelectionEntry>,
  selection: {
    readonly relativePath: string;
    readonly root: string | null;
    readonly primaryRoot: string;
  },
): string | null {
  const matches = entries.filter((entry) => entry.relativePath === selection.relativePath);
  if (selection.root !== null) {
    return matches.find((entry) => entry.root === selection.root)?.treePath ?? null;
  }
  return (
    matches.find((entry) => entry.root === undefined)?.treePath ??
    matches.find((entry) => entry.root === selection.primaryRoot)?.treePath ??
    (matches.length === 1 ? (matches[0]?.treePath ?? null) : null)
  );
}
