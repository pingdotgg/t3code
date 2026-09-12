import { formatPullRequest, type PullRequestRef } from "./PullRequest.ts";

/**
 * Tags a pull request assigned to a tarball. A content-addressed tarball
 * can be tied to several PRs at once (e.g. distilled packages pinned to the
 * same commit), so each PR owns its own tag list.
 */
export interface PullRequestBinding {
  ref: PullRequestRef;
  tags: string[];
  /**
   * Last time the PR was known to be open: set when CI ties it (a publish
   * proves the PR is open) and refreshed whenever GitHub reports `open`.
   * Bounds renewals when GitHub is unreachable.
   */
  verifiedAt: number;
}

export interface PackageState {
  packageName: string;
  hash: string;
  tags: string[];
  expiresAt: number;
  downloads: Record<string, number>;
  totalDownloads: number;
  ttlMillis?: number;
  pullRequests?: Record<string, PullRequestBinding>;
}

export const emptyState: PackageState = {
  packageName: "",
  hash: "",
  tags: [],
  expiresAt: 0,
  downloads: {},
  totalDownloads: 0,
};

export const pullRequestBindings = (
  state: PackageState,
): PullRequestBinding[] => Object.values(state.pullRequests ?? {});

/** Record that `tags` were assigned to this tarball on behalf of `ref`. */
export const tiePullRequest = (
  state: PackageState,
  ref: PullRequestRef,
  tags: string[],
  now: number,
): Record<string, PullRequestBinding> => {
  const key = formatPullRequest(ref);
  const existing = state.pullRequests?.[key];
  return {
    ...state.pullRequests,
    [key]: {
      ref,
      tags: [...new Set([...(existing?.tags ?? []), ...tags])],
      verifiedAt: now,
    },
  };
};

/**
 * Remove `tags` from the tarball and from every PR binding. A binding left
 * with no tags is dropped, so a tarball only renews while a tied PR still
 * owns at least one of its tags.
 */
export const withoutTags = (
  state: PackageState,
  tags: Iterable<string>,
): PackageState => {
  const removing = new Set(tags);
  const next: PackageState = {
    ...state,
    tags: state.tags.filter((tag) => !removing.has(tag)),
  };
  delete next.pullRequests;
  const pullRequests: Record<string, PullRequestBinding> = {};
  for (const [key, binding] of Object.entries(state.pullRequests ?? {})) {
    const remaining = binding.tags.filter((tag) => !removing.has(tag));
    if (remaining.length > 0) {
      pullRequests[key] = { ...binding, tags: remaining };
    }
  }
  if (Object.keys(pullRequests).length > 0) next.pullRequests = pullRequests;
  return next;
};

/**
 * Release the PR bindings matching `release`. Returns the tags that no
 * remaining PR still claims (those are safe to delete) and the state with
 * the released bindings removed. `pr-<n>` is always released with its PR.
 */
export const releasePullRequests = (
  state: PackageState,
  release: (binding: PullRequestBinding) => boolean,
): { tags: Set<string>; state: PackageState } => {
  const kept: Record<string, PullRequestBinding> = {};
  const owned = new Set<string>();
  for (const [key, binding] of Object.entries(state.pullRequests ?? {})) {
    if (release(binding)) {
      for (const tag of binding.tags) owned.add(tag);
      owned.add(`pr-${binding.ref.number}`);
    } else {
      kept[key] = binding;
    }
  }
  const claimed = new Set(Object.values(kept).flatMap((b) => b.tags));
  const tags = new Set([...owned].filter((tag) => !claimed.has(tag)));
  const next: PackageState = { ...state };
  delete next.pullRequests;
  if (Object.keys(kept).length > 0) next.pullRequests = kept;
  return { tags, state: next };
};
