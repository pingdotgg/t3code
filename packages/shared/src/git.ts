export const DEFAULT_WORKTREE_BRANCH_PREFIX = "t3code";

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

/**
 * Sanitize a worktree branch namespace/prefix while preserving slash-separated scopes.
 * Falls back to the default prefix when the input is empty after normalization.
 */
export function normalizeWorktreeBranchPrefix(raw: string | null | undefined): string {
  const normalized = raw
    ? raw
        .trim()
        .toLowerCase()
        .replace(/^refs\/heads\//, "")
        .replace(/['"`]/g, "")
    : "";

  const prefix = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return prefix && prefix.length > 0 ? prefix : DEFAULT_WORKTREE_BRANCH_PREFIX;
}

export function extractTemporaryWorktreeBranchPrefix(branch: string): string | null {
  const normalized = branch
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "");
  const match = /^(?<prefix>.+)\/(?<token>[0-9a-f]{8})$/u.exec(normalized);
  const prefix = match?.groups?.prefix?.trim();
  if (!prefix) {
    return null;
  }
  return normalizeWorktreeBranchPrefix(prefix);
}

export function isTemporaryWorktreeBranch(branch: string): boolean {
  return extractTemporaryWorktreeBranchPrefix(branch) !== null;
}

export function buildGeneratedWorktreeBranchName(
  raw: string,
  prefix: string | null | undefined,
): string {
  const normalizedPrefix = normalizeWorktreeBranchPrefix(prefix);
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${normalizedPrefix}/`)
    ? normalized.slice(`${normalizedPrefix}/`.length)
    : normalized;

  return `${normalizedPrefix}/${sanitizeBranchFragment(withoutPrefix)}`;
}

export function resolvePullRequestWorktreeLocalBranchName(input: {
  number: number;
  headBranch: string;
  isCrossRepository?: boolean;
  branchPrefix?: string | null | undefined;
}): string {
  if (!input.isCrossRepository) {
    return input.headBranch;
  }

  const prefix = normalizeWorktreeBranchPrefix(input.branchPrefix);
  const suffix = sanitizeBranchFragment(input.headBranch).trim();
  return `${prefix}/pr-${input.number}/${suffix.length > 0 ? suffix : "head"}`;
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
