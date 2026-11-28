import {
  legacyThreadPullRequestKey,
  threadPullRequestKeyOf,
} from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ProjectId,
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestListResult,
} from "@t3tools/contracts";
import {
  type composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";

import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

type LinkedComposerPullRequest = ReturnType<typeof composerPullRequestsFromLinks>[number];
export type ComposerPullRequestMenuItem = Extract<ComposerCommandItem, { type: "pull-request" }>;
export type ComposerPullRequestEmptyStateKind = "unavailable" | "error" | "no-match" | "empty";

export function hasComposerPullRequestSource(input: {
  readonly projectId: ProjectId | null;
  readonly repository: string | null;
  readonly hasTrackedFolders: boolean;
}): boolean {
  return input.projectId !== null && (input.repository !== null || input.hasTrackedFolders);
}

export function buildComposerPullRequestItems(input: {
  readonly projectId: ProjectId | null;
  readonly repository: string | null;
  readonly hasTrackedFolders: boolean;
  readonly query: string;
  readonly triggerNumber: number | null;
  readonly listedEntries: ReadonlyArray<PullRequestListEntry>;
  readonly providers: PullRequestListResult["providers"];
  readonly exactDetails: ReadonlyArray<PullRequestDetail>;
  readonly linkedPullRequests: ReadonlyArray<LinkedComposerPullRequest>;
  readonly limit: number;
}): ComposerPullRequestMenuItem[] {
  if (!hasComposerPullRequestSource(input) || input.projectId === null) {
    return [];
  }
  const normalizedRepository = input.repository?.trim().toLowerCase() ?? null;
  const exactPullRequests = input.exactDetails
    .filter((detail) => detail.number === input.triggerNumber)
    .map((detail) => ({
      ...detail,
      // Only the host: the URL's full repository path would not match the project's selector.
      host: legacyThreadPullRequestKey(detail).host,
    }));
  const matches = /^\d*$/u.test(input.query)
    ? filterComposerPullRequestMatches({
        keyOf: threadPullRequestKeyOf,
        entries: [...exactPullRequests, ...input.listedEntries],
        linked: input.linkedPullRequests,
        projectId: input.projectId,
        repository: input.repository,
        query: input.query,
        limit: input.limit,
      })
    : withLinkedComposerPullRequestsFirst({
        keyOf: threadPullRequestKeyOf,
        matches: rankPullRequestMatches(
          input.listedEntries.filter((entry) => {
            if (
              entry.projectId !== input.projectId ||
              (normalizedRepository !== null &&
                entry.repository.trim().toLowerCase() !== normalizedRepository)
            ) {
              return false;
            }
            const provider = input.providers.find((candidate) => candidate.host === entry.host);
            return provider?.searchesOnHost === true || matchesPullRequestQuery(entry, input.query);
          }),
          input.query,
        ),
        linked: input.linkedPullRequests,
        query: input.query,
        limit: input.limit,
      });
  return matches.map((pullRequest) => ({
    id: `pull-request:${pullRequest.projectId}:${threadPullRequestKeyOf(pullRequest)}`,
    type: "pull-request",
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
    },
    label: `#${pullRequest.number}`,
    description:
      normalizedRepository !== null &&
      pullRequest.repository.trim().toLowerCase() === normalizedRepository
        ? pullRequest.title
        : `${pullRequest.repository} · ${pullRequest.title}`,
  }));
}

export function resolveComposerPullRequestEmptyStateKind(input: {
  readonly projectId: ProjectId | null;
  readonly repository: string | null;
  readonly hasTrackedFolders: boolean;
  readonly query: string;
  readonly listData: {
    readonly providers: ReadonlyArray<unknown>;
    readonly entries: ReadonlyArray<unknown>;
    readonly errors: ReadonlyArray<{ readonly projectId: ProjectId }>;
  } | null;
  readonly listError: unknown;
  readonly detailError?: unknown;
}): ComposerPullRequestEmptyStateKind {
  const detailError = input.detailError ?? null;
  const trackedFoldersHaveNoRepository =
    input.repository === null &&
    input.listData !== null &&
    input.listError === null &&
    detailError === null &&
    input.listData.providers.length === 0 &&
    input.listData.entries.length === 0 &&
    input.listData.errors.length === 0;
  if (!hasComposerPullRequestSource(input) || trackedFoldersHaveNoRepository) {
    return "unavailable";
  }
  if (
    input.listError !== null ||
    detailError !== null ||
    input.listData?.errors.some((error) => error.projectId === input.projectId)
  ) {
    return "error";
  }
  return input.query ? "no-match" : "empty";
}
