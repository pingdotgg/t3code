import { buildReviewParsedDiff, type ReviewParsedDiff } from "./reviewModel";

export interface WorkspaceReviewDiff {
  readonly path: string;
  readonly diff: string;
}

export function buildWorkspaceReviewDiff(
  entries: readonly WorkspaceReviewDiff[],
  cacheScope: string,
): ReviewParsedDiff {
  const files: Extract<ReviewParsedDiff, { kind: "files" }>["files"][number][] = [];
  const notices: string[] = [];
  let hasRawPatch = false;
  for (const entry of entries) {
    const parsed = buildReviewParsedDiff(entry.diff, `${cacheScope}:${entry.path}`);
    if (parsed.kind === "raw") {
      hasRawPatch = true;
      notices.push(`${entry.path}: ${parsed.reason}`);
      continue;
    }
    if (parsed.kind !== "files") continue;
    if (parsed.notice) notices.push(`${entry.path}: ${parsed.notice}`);
    const prefix = entry.path === "." ? "" : `${entry.path}/`;
    for (const file of parsed.files) {
      files.push({
        ...file,
        id: `${entry.path}:${file.id}`,
        path: `${prefix}${file.path}`,
        previousPath: file.previousPath ? `${prefix}${file.previousPath}` : null,
      });
    }
  }
  if (hasRawPatch) {
    return {
      kind: "raw",
      text: entries.map((entry) => `Repository: ${entry.path}\n${entry.diff}`).join("\n\n"),
      reason: notices.join("\n"),
      notice: null,
    };
  }
  if (files.length === 0 && notices.length === 0) return { kind: "empty" };
  return {
    kind: "files",
    files,
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    notice: notices.join("\n") || null,
  };
}
