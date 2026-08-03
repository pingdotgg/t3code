/**
 * fork: f4 — pure path containment, the security boundary of the git panel.
 *
 * Every `workingCopy.*` RPC carries a caller-supplied `cwd`. An RPC that runs
 * arbitrary git in an arbitrary directory is a sandbox escape, so the cwd —
 * and the repository root git resolves it to — must both sit inside an open
 * project root or a thread worktree. Denial **throws**; it never returns a
 * shaped empty, because a plausible empty value reads as "this repo has
 * nothing".
 */

/** Normalize separators and drop a trailing separator, keeping a bare root. */
export function normalizeContainmentPath(value: string): string {
  const unified = value.replaceAll("\\", "/");
  if (unified.length > 1 && unified.endsWith("/")) {
    return unified.replace(/\/+$/, "") || "/";
  }
  return unified;
}

/**
 * Segment-aware containment. `/a/bc` is **not** inside `/a/b`, which a plain
 * `startsWith` would get wrong.
 */
export function isPathContained(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeContainmentPath(candidate);
  const normalizedRoot = normalizeContainmentPath(root);
  if (normalizedRoot.length === 0 || normalizedCandidate.length === 0) {
    return false;
  }
  if (normalizedCandidate === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(prefix);
}

/**
 * The first root containing `candidate`, or `null`. Returning the root rather
 * than a boolean keeps the denial error able to say nothing at all about which
 * roots exist.
 */
export function findContainingRoot(candidate: string, roots: Iterable<string>): string | null {
  for (const root of roots) {
    if (isPathContained(candidate, root)) {
      return normalizeContainmentPath(root);
    }
  }
  return null;
}
