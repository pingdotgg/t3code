import type { RepositoryIdentity } from "@t3tools/contracts";

import { parseChangeRequestUrl, repositoryFromIdentity } from "./pullRequestLinks";

export type PullRequestDetailRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: string;
  readonly repository: string;
};

export type PullRequestCommentRouteParams = PullRequestDetailRouteParams & {
  readonly mode: "comment" | "review" | "reply";
  readonly threadId?: string;
};

export type PullRequestDiffRouteParams = PullRequestDetailRouteParams & {
  readonly path?: string;
};

export function parseRoutePositiveInt(value: string | number | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The native detail route for a change request the git status already knows about, or null
 * when the URL is not a host this page can read and the project has no repository identity
 * to fall back on. Null means the system browser.
 */
export function resolveNativePullRequestTarget(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly url: string;
  readonly number?: number | null;
  readonly repositoryIdentity?: Pick<RepositoryIdentity, "displayName" | "owner" | "name"> | null;
}): PullRequestDetailRouteParams | null {
  const parsed = parseChangeRequestUrl(input.url);
  const repository = parsed?.repository ?? repositoryFromIdentity(input.repositoryIdentity ?? null);
  const number = parsed?.number ?? input.number ?? null;
  if (repository === null || number === null) return null;
  return {
    environmentId: input.environmentId,
    projectId: input.projectId,
    repository,
    number: String(number),
  };
}
