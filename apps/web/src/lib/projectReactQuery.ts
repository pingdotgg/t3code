import type {
  EnvironmentId,
  ProjectDetails,
  ProjectId,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  details: (environmentId: EnvironmentId | null, projectId: ProjectId | null) =>
    ["projects", "details", environmentId ?? null, projectId ?? null] as const,
  searchEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit: number,
  ) => ["projects", "search-entries", environmentId ?? null, cwd, query, limit] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectDetailsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.details(input.environmentId, input.projectId),
    queryFn: async (): Promise<ProjectDetails> => {
      if (!input.environmentId || !input.projectId) {
        throw new Error("Project details are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.getDetails({
        projectId: input.projectId,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.projectId !== null,
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
  });
}

export function projectSearchEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.environmentId, input.cwd, input.query, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}
