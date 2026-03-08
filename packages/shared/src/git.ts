/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export const WORKTREE_BRANCH_PREFIX = "OSSCode";

const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^${WORKTREE_BRANCH_PREFIX.toLowerCase()}\\/[0-9a-f]{8}$`,
);

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for temporary-branch detection.
  const token = crypto.randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw.trim().replace(/^refs\/heads\//i, "");
  const worktreePrefix = `${WORKTREE_BRANCH_PREFIX.toLowerCase()}/`;
  const withoutPrefix = normalized.toLowerCase().startsWith(worktreePrefix)
    ? normalized.slice(worktreePrefix.length)
    : normalized;

  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(withoutPrefix)}`;
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  if (!existingNames.has(resolvedBase)) {
    return resolvedBase;
  }

  let suffix = 2;
  while (existingNames.has(`${resolvedBase}-${suffix}`)) {
    suffix += 1;
  }

  return `${resolvedBase}-${suffix}`;
}
