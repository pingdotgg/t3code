import type { OrchestrationListArchivedThreadsResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const orchestrationQueryKeys = {
  all: ["orchestration"] as const,
  archivedThreads: () => ["orchestration", "archived-threads"] as const,
};

const DEFAULT_ARCHIVED_THREADS_STALE_TIME = 15_000;
const EMPTY_ARCHIVED_THREADS: OrchestrationListArchivedThreadsResult = [];

export function archivedThreadsQueryOptions() {
  return queryOptions({
    queryKey: orchestrationQueryKeys.archivedThreads(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.orchestration.listArchivedThreads();
    },
    staleTime: DEFAULT_ARCHIVED_THREADS_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_ARCHIVED_THREADS,
  });
}
