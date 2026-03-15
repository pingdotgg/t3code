import type { GitWorktreeBranchNaming } from "@t3tools/contracts";

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
export const DEFAULT_WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_TOKEN_PATTERN = /^[0-9a-f]{8}$/;

function resolveWorktreeBranchPrefix(naming?: GitWorktreeBranchNaming): string {
  if (naming?.mode === "prefix") {
    return sanitizeBranchFragment(naming.prefix);
  }
  return DEFAULT_WORKTREE_BRANCH_PREFIX;
}

function stripKnownWorktreePrefix(raw: string, configuredPrefix: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");
  const candidatePrefixes = new Set([configuredPrefix, DEFAULT_WORKTREE_BRANCH_PREFIX]);
  for (const prefix of candidatePrefixes) {
    const prefixWithSeparator = `${prefix}/`;
    if (normalized.startsWith(prefixWithSeparator)) {
      return normalized.slice(prefixWithSeparator.length);
    }
  }
  return normalized;
}

export function buildInitialWorktreeBranchName(
  naming?: GitWorktreeBranchNaming,
  token = crypto.randomUUID().slice(0, 8).toLowerCase(),
): string {
  if (naming?.mode === "full") {
    return naming.branchName.trim();
  }
  return `${resolveWorktreeBranchPrefix(naming)}/${token}`;
}

export function buildFinalWorktreeBranchName(
  rawGeneratedBranch: string,
  naming?: GitWorktreeBranchNaming,
): string {
  if (naming?.mode === "full") {
    return naming.branchName.trim();
  }

  const prefix = resolveWorktreeBranchPrefix(naming);
  const branchFragment = sanitizeBranchFragment(
    stripKnownWorktreePrefix(rawGeneratedBranch, prefix),
  );
  return `${prefix}/${branchFragment}`;
}

export function isTemporaryWorktreeBranchName(
  branch: string,
  naming?: GitWorktreeBranchNaming,
): boolean {
  if (naming?.mode === "full") {
    return false;
  }

  const normalized = branch.trim().toLowerCase();
  const prefix = resolveWorktreeBranchPrefix(naming);
  if (!normalized.startsWith(`${prefix}/`)) {
    return false;
  }
  const token = normalized.slice(prefix.length + 1);
  return TEMP_WORKTREE_BRANCH_TOKEN_PATTERN.test(token);
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
