import type { NativeApi } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { asThreadId } from "./orchestrationIds";

export interface CheckpointDiffQueryInput {
  threadId: string | null;
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
      input.threadId,
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
      if (!api || !input.threadId || !hasValidRange) {
        throw new Error("Checkpoint diff is unavailable.");
      }
      const { fromTurnCount, toTurnCount } = input;
      if (typeof fromTurnCount !== "number" || typeof toTurnCount !== "number") {
        throw new Error("Checkpoint diff range is invalid.");
      }
      if (fromTurnCount === 0) {
        return api.orchestration.getFullThreadDiff({
          threadId: asThreadId(input.threadId),
          toTurnCount,
        });
      }
      return api.orchestration.getTurnDiff({
        threadId: asThreadId(input.threadId),
        fromTurnCount,
        toTurnCount,
      });
    },
    enabled: !!api && !!input.threadId && hasValidRange,
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
