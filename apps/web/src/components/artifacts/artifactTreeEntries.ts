import type { PublishedArtifact } from "@t3tools/shared/publishedArtifacts";

function treeSegment(value: string): string {
  return value.replaceAll("/", "⁄").trim() || "untitled";
}

function uniqueTreePath(used: Map<string, number>, candidate: string): string {
  const count = (used.get(candidate) ?? 0) + 1;
  used.set(candidate, count);
  if (count === 1) return candidate;
  const dot = candidate.lastIndexOf(".");
  if (dot > 0) return `${candidate.slice(0, dot)} (${count})${candidate.slice(dot)}`;
  return `${candidate} (${count})`;
}

export function artifactTreeEntries(artifacts: ReadonlyArray<PublishedArtifact>) {
  const used = new Map<string, number>();
  return artifacts.map((artifact) => {
    const preferred =
      artifact.kind === "html-render"
        ? `${treeSegment(artifact.title)}.html`
        : artifact.path
          ? treeSegment(artifact.path.split(/[\\/]/).at(-1) || artifact.title)
          : `${treeSegment(artifact.title)}.url`;
    return { path: uniqueTreePath(used, preferred), artifact };
  });
}
