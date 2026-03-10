export const DEFAULT_WORKTREE_BRANCH_PREFIX = "feature";
const TEMP_WORKTREE_BRANCH_TOKEN_PATTERN = /^[0-9a-f]{8}$/;

function stripBranchNoise(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/\bwww\.\S+/g, " ")
    .replace(/\b(?:github|gitlab|bitbucket)\.com\/\S+/g, " ")
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes and URLs, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = stripBranchNoise(raw);

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export function sanitizeWorktreeBranchPrefix(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) {
    return DEFAULT_WORKTREE_BRANCH_PREFIX;
  }
  const normalized = sanitizeBranchFragment(trimmed);
  return normalized.length > 0 ? normalized : DEFAULT_WORKTREE_BRANCH_PREFIX;
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

export function buildWorktreeBranchName(
  prefixRaw: string | null | undefined,
  rawFragment: string,
): string {
  const prefix = sanitizeWorktreeBranchPrefix(prefixRaw);
  const sanitizedFragment = sanitizeBranchFragment(rawFragment);
  const branchFragment =
    sanitizedFragment === prefix
      ? ""
      : sanitizedFragment.startsWith(`${prefix}/`)
        ? sanitizedFragment.slice(prefix.length + 1)
        : sanitizedFragment;
  return `${prefix}/${branchFragment.length > 0 ? branchFragment : "update"}`;
}

export function buildTemporaryWorktreeBranchName(prefixRaw: string | null | undefined): string {
  return `${sanitizeWorktreeBranchPrefix(prefixRaw)}/${crypto.randomUUID().slice(0, 8).toLowerCase()}`;
}

export function isTemporaryWorktreeBranch(
  branch: string,
  prefixRaw: string | null | undefined,
): boolean {
  const prefix = sanitizeWorktreeBranchPrefix(prefixRaw);
  const match = branch.trim().toLowerCase().match(new RegExp(`^${escapeRegExp(prefix)}\\/(.+)$`));
  if (!match) {
    return false;
  }
  return TEMP_WORKTREE_BRANCH_TOKEN_PATTERN.test(match[1] ?? "");
}

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
