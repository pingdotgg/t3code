import type {
  PullRequestRef,
  PullRequestReviewVerdict,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";

import { parseChangeRequestUrl, repositoryFromIdentity } from "./pullRequestLinks";

export type PullRequestDetailRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: string;
  /**
   * `owner/repo` travels as a navigate extra, not a linking path segment: a slash in the
   * name would split the URL. Deep links omit it and the project identity fills it in.
   */
  readonly repository?: string;
};

export type PullRequestCommentRouteParams = PullRequestDetailRouteParams & {
  readonly mode: "comment" | "review" | "reply";
  readonly threadId?: string;
  /** Intersected host ∩ viewer verdicts. Absent on a deep link, which offers Comment only. */
  readonly verdicts?: ReadonlyArray<PullRequestReviewVerdict>;
};

export type PullRequestDiffRouteParams = PullRequestDetailRouteParams & {
  readonly path?: string;
};

export function parseRoutePositiveInt(value: string | number | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolvePullRequestRouteRepository(input: {
  readonly repository?: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly projects: ReadonlyArray<{
    readonly environmentId: unknown;
    readonly id: unknown;
    readonly repositoryIdentity?: Pick<RepositoryIdentity, "displayName" | "owner" | "name"> | null;
  }>;
}): string | null {
  const fromParams = input.repository?.trim() ?? "";
  if (fromParams.length > 0) return fromParams;
  const project = input.projects.find(
    (candidate) =>
      String(candidate.environmentId) === input.environmentId &&
      String(candidate.id) === input.projectId,
  );
  return repositoryFromIdentity(project?.repositoryIdentity ?? null);
}

export function resolvePullRequestRouteReference(
  params: PullRequestDetailRouteParams,
  projects: ReadonlyArray<{
    readonly environmentId: unknown;
    readonly id: unknown;
    readonly repositoryIdentity?: Pick<RepositoryIdentity, "displayName" | "owner" | "name"> | null;
  }>,
): PullRequestRef | null {
  const number = parseRoutePositiveInt(params.number);
  const repository = resolvePullRequestRouteRepository({
    repository: params.repository,
    environmentId: params.environmentId,
    projectId: params.projectId,
    projects,
  });
  if (number === null || repository === null) return null;
  return {
    projectId: ProjectId.make(params.projectId),
    repository,
    number,
  };
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
