import type { NativeApi } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
};

export function serverConfigQueryOptions(api: NativeApi | undefined) {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      if (!api || !api.server || typeof api.server.getConfig !== "function") {
        throw new Error("Server config is unavailable.");
      }
      return api.server.getConfig();
    },
    enabled: !!api && !!api.server && typeof api.server.getConfig === "function",
    staleTime: Infinity,
  });
}
