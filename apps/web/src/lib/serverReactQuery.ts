import { queryOptions } from "@tanstack/react-query";
import type { ServerGetCodexRateLimitsInput } from "@t3tools/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  codexRateLimits: (input: ServerGetCodexRateLimitsInput) =>
    ["server", "codexRateLimits", input.binaryPath ?? null, input.homePath ?? null] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function serverCodexRateLimitsQueryOptions(
  input: ServerGetCodexRateLimitsInput & { enabled?: boolean },
) {
  return queryOptions({
    queryKey: serverQueryKeys.codexRateLimits(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getCodexRateLimits({
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.homePath ? { homePath: input.homePath } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}
