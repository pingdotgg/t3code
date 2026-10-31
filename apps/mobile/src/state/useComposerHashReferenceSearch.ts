import type { EnvironmentId, ProjectId, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  filterComposerRepoReferenceMatches,
  linkedComposerPullRequestReferences,
  type LinkedComposerPullRequestReference,
  withLinkedComposerRepoReferencesFirst,
} from "@t3tools/shared/composerRepoReferenceMatches";

import { composerPullRequests } from "./pull-requests";
import { useEnvironmentQuery } from "./query";
import { useDebouncedValue } from "./queries";

type HashReferenceEntry =
  | LinkedComposerPullRequestReference
  | {
      readonly kind: "issue";
      readonly projectId: string;
      readonly repository: string;
      readonly number: number;
      readonly title: string;
      readonly url: string;
      readonly state: "open" | "closed";
      readonly updatedAt: string;
    }
  | {
      readonly kind: "discussion";
      readonly projectId: string;
      readonly repository: string;
      readonly number: number;
      readonly title: string;
      readonly url: string;
      readonly state: "open" | "closed";
      readonly updatedAt: string;
      readonly category?: string;
    };

export function useComposerHashReferenceSearch(input: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  repository: string | null;
  threadPullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  query: string | null;
}) {
  const query = useDebouncedValue(input.query, 180);
  const linked =
    input.projectId === null
      ? []
      : linkedComposerPullRequestReferences(input.threadPullRequests ?? [], input.projectId);
  const ready =
    query === input.query &&
    query !== null &&
    input.environmentId !== null &&
    input.projectId !== null &&
    input.repository !== null;
  const search = useEnvironmentQuery(
    ready
      ? composerPullRequests.searchReferences({
          environmentId: input.environmentId!,
          input: {
            projectId: input.projectId!,
            repository: input.repository!,
            limit: 20,
            ...(query.length > 0 ? { query } : {}),
          },
        })
      : null,
  );

  const entries = ((): ReadonlyArray<HashReferenceEntry> => {
    if (input.query === null || input.projectId === null || input.repository === null) return [];
    const found: ReadonlyArray<HashReferenceEntry> = ready ? (search.data?.entries ?? []) : [];
    if (/^\d*$/u.test(input.query)) {
      return filterComposerRepoReferenceMatches({
        entries: found,
        linked,
        projectId: input.projectId,
        repository: input.repository,
        query: input.query,
        limit: 20,
      });
    }
    return withLinkedComposerRepoReferencesFirst({
      matches: found,
      linked,
      query: input.query,
      limit: 20,
    });
  })();

  return {
    entries,
    isPending: input.query !== null && (query !== input.query || search.isPending),
    error: search.error ?? search.data?.errors[0]?.message ?? null,
  };
}
