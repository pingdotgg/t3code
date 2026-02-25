import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  ThreadId,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";

interface CheckpointDiffQueryInput {
  threadId: ThreadId | null;
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

function decodeCheckpointDiffRequest(input: CheckpointDiffQueryInput) {
  if (input.fromTurnCount === 0) {
    return Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput)({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiff" as const, input: fields })));
  }

  return Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput)({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
  }).pipe(Option.map((fields) => ({ kind: "turnDiff" as const, input: fields })));
}

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

export function checkpointDiffQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeCheckpointDiffRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.threadId || decodedRequest._tag === "None") {
        throw new Error("Checkpoint diff is unavailable.");
      }
      if (decodedRequest.value.kind === "fullThreadDiff") {
        return api.orchestration.getFullThreadDiff(decodedRequest.value.input);
      }
      return api.orchestration.getTurnDiff(decodedRequest.value.input);
    },
    enabled: !!input.threadId && decodedRequest._tag === "Some",
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
