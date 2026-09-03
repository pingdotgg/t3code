/**
 * Normalizes persisted provider and worktree paths for usage attribution.
 *
 * Provider transcripts can retain paths written on another platform or with a
 * different slash style, so attribution cannot rely on the host separator.
 */
export function normalizeUsagePath(value: string): string {
  const slashPath = value.replaceAll("\\", "/");
  const rooted = slashPath.startsWith("/");
  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") segments.pop();
      else if (!rooted) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  const normalized = `${rooted ? "/" : ""}${segments.join("/")}`;
  return normalized === "" ? (rooted ? "/" : ".") : normalized;
}

/** Returns a normalized dedicated worktree, excluding the shared project root. */
export function dedicatedUsageWorktreePath(
  projectRoot: string,
  worktree: string | null,
): string | null {
  const candidate = worktree?.trim() ?? "";
  if (candidate.length === 0) return null;
  const normalized = normalizeUsagePath(candidate);
  return normalized === normalizeUsagePath(projectRoot) ? null : normalized;
}
