import type { ProjectId } from "@t3tools/contracts";
import type { ProjectSearchEntriesResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (projectId: ProjectId | null, query: string, limit: number) =>
    ["projects", "search-entries", projectId, query, limit] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  projectId: ProjectId | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.projectId, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.projectId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        projectId: input.projectId,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.projectId !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}
