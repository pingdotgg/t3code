/**
 * Fork-only. A project's worktree layout command reads `LATHE_PROJECT_ROOT` and
 * `LATHE_WORKTREE_*`. Upstream hands the same values over as `T3_*`, and a project file shared
 * with T3 Code users is written against those names, so the command gets both spellings. Lathe's
 * docs name only its own.
 */
export function withUpstreamLayoutNames(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const exported: Record<string, string> = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LATHE_")) exported[`T3_${name.slice("LATHE_".length)}`] = value;
  }
  return exported;
}
