/** Last path segment of a repository root, for compact UI labels. */
export function repoRootBaseName(rootPath: string): string {
  const trimmed = rootPath.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed;
}

/** Build root-keyed filter options, disambiguating duplicate basenames. */
export function buildRepoFilterOptions(repoRoots: ReadonlyArray<string>) {
  const uniqueRoots = Array.from(new Set(repoRoots));
  const baseNameCounts = new Map<string, number>();
  for (const repoRoot of uniqueRoots) {
    const baseName = repoRootBaseName(repoRoot);
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }
  return uniqueRoots.map((repoRoot) => {
    const baseName = repoRootBaseName(repoRoot);
    return {
      repoRoot,
      displayName: (baseNameCounts.get(baseName) ?? 0) > 1 ? repoRoot : baseName,
    };
  });
}

/** Scope a relative diff-file key to its repository in grouped views. */
export function scopedDiffFileKey(fileKey: string, repoRoot?: string): string {
  return repoRoot === undefined ? fileKey : `${repoRoot}\u0000${fileKey}`;
}
