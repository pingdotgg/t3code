import type {
  ServerCopilotReasoningProbe,
  ServerCopilotReasoningProbeInput,
  ServerCopilotUsage,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";

const COPILOT_USAGE_QUERY_TIMEOUT_MS = 10_000;

function buildUnavailableCopilotUsage(message: string): ServerCopilotUsage {
  return {
    status: "unavailable",
    fetchedAt: new Date().toISOString(),
    message,
  } satisfies ServerCopilotUsage;
}

async function readCopilotUsageSafely(): Promise<ServerCopilotUsage> {
  const api = ensureNativeApi();

  try {
    const timeoutPromise = new Promise<ServerCopilotUsage>((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          buildUnavailableCopilotUsage("GitHub Copilot quota request timed out."),
        );
      }, COPILOT_USAGE_QUERY_TIMEOUT_MS);

      void api.server.getCopilotUsage().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          const detail = error instanceof Error ? error.message.trim() : String(error).trim();
          resolve(
            buildUnavailableCopilotUsage(
              detail.length > 0
                ? `GitHub Copilot quota request failed: ${detail}`
                : "GitHub Copilot quota request failed.",
            ),
          );
        },
      );
    });

    return await timeoutPromise;
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : String(error).trim();
    return buildUnavailableCopilotUsage(
      detail.length > 0
        ? `GitHub Copilot quota request failed: ${detail}`
        : "GitHub Copilot quota request failed.",
    );
  }
}

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  copilotUsage: () => ["server", "copilotUsage"] as const,
  copilotReasoningProbe: (input: ServerCopilotReasoningProbeInput) =>
    ["server", "copilotReasoningProbe", input.model, input.binaryPath ?? null] as const,
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

export function serverCopilotUsageQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: serverQueryKeys.copilotUsage(),
    queryFn: readCopilotUsageSafely,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    enabled,
    retry: false,
  });
}

export function serverCopilotReasoningProbeQueryOptions(
  input: ServerCopilotReasoningProbeInput,
  enabled = true,
) {
  return queryOptions<ServerCopilotReasoningProbe>({
    queryKey: serverQueryKeys.copilotReasoningProbe(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.probeCopilotReasoning(input);
    },
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    enabled,
    retry: false,
  });
}
