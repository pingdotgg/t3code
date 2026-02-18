import type { NativeApi } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

export interface CheckpointDiffQueryInput {
  sessionId: string | null;
  threadRuntimeId: string | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.sessionId,
      input.threadRuntimeId,
      input.fromTurnCount,
      input.toTurnCount,
    ] as const,
};

export function checkpointDiffQueryOptions(
  api: NativeApi | undefined,
  input: CheckpointDiffQueryInput,
) {
  const hasValidRange =
    typeof input.fromTurnCount === "number" && typeof input.toTurnCount === "number";

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async () => {
      if (!api || !input.sessionId || !hasValidRange) {
        throw new Error("Checkpoint diff is unavailable.");
      }
      const { fromTurnCount, toTurnCount } = input;
      if (typeof fromTurnCount !== "number" || typeof toTurnCount !== "number") {
        throw new Error("Checkpoint diff range is invalid.");
      }
      return api.providers.getCheckpointDiff({
        sessionId: input.sessionId,
        fromTurnCount,
        toTurnCount,
      });
    },
    enabled: !!api && !!input.sessionId && hasValidRange,
    staleTime: Infinity,
    retry: 8,
    retryDelay: (attempt) => Math.min(2_000, 150 * 2 ** (attempt - 1)),
  });
}
