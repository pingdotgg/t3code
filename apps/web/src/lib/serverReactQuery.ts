import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  recheckProviderHealth: (codexBinaryPath: string | undefined) =>
    ["server", "recheckProviderHealth", codexBinaryPath ?? null] as const,
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

export function serverRecheckProviderHealthQueryOptions(input: {
  codexBinaryPath: string | undefined;
  queryClient: QueryClient;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: serverQueryKeys.recheckProviderHealth(input.codexBinaryPath),
    queryFn: async () => {
      const api = ensureNativeApi();
      const config = await api.server.recheckProviderHealth({
        codexBinaryPath: input.codexBinaryPath,
      });
      // Seed the server config cache so the rest of the app immediately
      // sees the updated provider statuses without a second round-trip.
      input.queryClient.setQueryData(serverQueryKeys.config(), config);
      return config;
    },
    enabled: input.enabled ?? true,
    staleTime: Infinity,
  });
}
