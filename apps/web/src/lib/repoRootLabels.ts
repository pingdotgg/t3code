/**
 * Build the shortest unique suffix label for each repository root.
 * Basenames stay compact unless cousin roots share one, in which case parent
 * segments are added until the labels are distinct.
 */
export function buildRepoRootLabels(roots: readonly string[]): Map<string, string> {
  const uniqueRoots = [...new Set(roots)];
  const segments = new Map<string, string[]>();
  for (const root of uniqueRoots) {
    segments.set(
      root,
      root
        .replaceAll("\\", "/")
        .replace(/\/+$/, "")
        .split("/")
        .filter((segment) => segment.length > 0),
    );
  }

  const labels = new Map<string, string>();
  for (const root of uniqueRoots) {
    const parts = segments.get(root) ?? [];
    let depth = 1;
    let label = parts.slice(-depth).join("/") || root;
    while (
      depth < parts.length &&
      uniqueRoots.some(
        (other) => other !== root && (segments.get(other) ?? []).slice(-depth).join("/") === label,
      )
    ) {
      depth += 1;
      label = parts.slice(-depth).join("/");
    }
    labels.set(root, label);
  }
  return labels;
}
