import type { ProjectEntry } from "@t3tools/contracts";

/**
 * Maps project entries to the path strings the file tree consumes. The tree
 * model throws on duplicate paths and takes the whole panel down with it, so
 * duplicates are dropped here even though the server should never send them.
 */
export function buildTreePaths(entries: ReadonlyArray<ProjectEntry>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.kind === "directory" ? `${entry.path}/` : entry.path;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
