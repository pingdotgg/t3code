import type {
  EnvironmentId,
  ProjectLocalAgentInventoryResult,
  ProjectSearchEntriesResult,
} from "@harness/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntriesScope: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["projects", "search-entries", environmentId ?? null, cwd] as const,
  localAgentInventoryScope: (environmentId: EnvironmentId | null, cwd: string | null) =>
    ["projects", "local-agent-inventory", environmentId ?? null, cwd] as const,
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
const EMPTY_LOCAL_AGENT_INVENTORY_RESULT: ProjectLocalAgentInventoryResult = {
  skills: [],
  commands: [],
};

export function invalidateProjectQueries(
  queryClient: QueryClient,
  input?: { environmentId?: EnvironmentId | null; cwd?: string | null },
) {
  const environmentId = input?.environmentId ?? null;
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.searchEntriesScope(environmentId, cwd),
      }),
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.localAgentInventoryScope(environmentId, cwd),
      }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
}

export function projectLocalAgentInventoryQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.localAgentInventoryScope(input.environmentId, input.cwd),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Project-local agent inventory is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.getLocalAgentInventory({
        cwd: input.cwd,
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_LOCAL_AGENT_INVENTORY_RESULT,
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
