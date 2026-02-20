import type { NativeApi } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

export interface CheckpointDiffQueryInput {
  sessionId: string | null;
  threadRuntimeId: string | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  cacheScope?: string | null;
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
      input.cacheScope ?? null,
    ] as const,
};

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

export function checkpointDiffQueryOptions(
  api: NativeApi | undefined,
  input: CheckpointDiffQueryInput,
) {
  const hasValidRange =
    typeof input.fromTurnCount === "number" &&
    typeof input.toTurnCount === "number" &&
    Number.isInteger(input.fromTurnCount) &&
    Number.isInteger(input.toTurnCount) &&
    input.fromTurnCount >= 0 &&
    input.toTurnCount >= 0 &&
    input.fromTurnCount <= input.toTurnCount;

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
    retry: (failureCount, error) => {
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < 12;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) =>
      isCheckpointTemporarilyUnavailable(error)
        ? Math.min(5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1)),
  });
}
