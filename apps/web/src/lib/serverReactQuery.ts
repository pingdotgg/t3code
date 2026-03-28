import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
};

/**
 * Server config query options.
 *
 * `staleTime` is kept short so that push-driven `invalidateQueries` calls in
 * the EventRouter always trigger a refetch, and so the query re-fetches when
 * the component re-mounts (e.g. navigating away from settings and back).
 */
export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
  });
}
