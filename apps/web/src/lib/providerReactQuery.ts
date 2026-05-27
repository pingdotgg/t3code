import {
  type EnvironmentId,
  OrchestrationGetFullThreadDiffStateInput,
  OrchestrationGetTurnDiffStateInput,
  type ProviderDriverKind,
  type ServerProviderListCommandsResult,
  ThreadId,
  type TurnDiffScope,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ensureEnvironmentApi } from "../environmentApi";

interface CheckpointDiffQueryInput {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  kind?: "turn" | "conversation";
  scope?: TurnDiffScope | null;
  cacheScope?: string | null;
  enabled?: boolean;
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  commands: (
    environmentId: EnvironmentId | null,
    provider: ProviderDriverKind | null,
    cwd: string | null,
  ) => ["providers", "commands", environmentId ?? null, provider ?? null, cwd ?? null] as const,
  diffState: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "diffState",
      input.environmentId ?? null,
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.kind ?? "conversation",
      input.scope ?? "snapshot",
      input.cacheScope ?? null,
    ] as const,
};

const EMPTY_PROVIDER_COMMANDS_RESULT: ServerProviderListCommandsResult = {
  commands: [],
};

const decodeFullThreadDiffStateInput = Schema.decodeUnknownOption(
  OrchestrationGetFullThreadDiffStateInput,
);
const decodeTurnDiffStateInput = Schema.decodeUnknownOption(OrchestrationGetTurnDiffStateInput);

function decodeDiffStateRequest(input: CheckpointDiffQueryInput) {
  if ((input.kind ?? "conversation") === "conversation") {
    return decodeFullThreadDiffStateInput({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiffState" as const, input: fields })));
  }

  return decodeTurnDiffStateInput({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    scope: input.scope ?? "snapshot",
  }).pipe(Option.map((fields) => ({ kind: "turnDiffState" as const, input: fields })));
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

function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project is not a git repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    message.includes("checkpoint is unavailable for turn") ||
    message.includes("filesystem checkpoint is unavailable")
  );
}

export function diffStateQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeDiffStateRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.diffState(input),
    queryFn: async () => {
      if (!input.environmentId || !input.threadId || decodedRequest._tag === "None") {
        throw new Error("Diff state is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      try {
        if (decodedRequest.value.kind === "fullThreadDiffState") {
          return await api.orchestration.getFullThreadDiffState(decodedRequest.value.input);
        }
        return await api.orchestration.getTurnDiffState(decodedRequest.value.input);
      } catch (error) {
        throw new Error(normalizeCheckpointErrorMessage(error), { cause: error });
      }
    },
    enabled:
      (input.enabled ?? true) &&
      !!input.environmentId &&
      !!input.threadId &&
      decodedRequest._tag === "Some",
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

export function providerCommandsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  provider: ProviderDriverKind | null;
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerQueryKeys.commands(input.environmentId, input.provider, input.cwd),
    queryFn: async () => {
      if (!input.environmentId || !input.provider || !input.cwd) {
        throw new Error("Provider commands are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.server.listProviderCommands({
        provider: input.provider,
        cwd: input.cwd,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.provider !== null &&
      input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_PROVIDER_COMMANDS_RESULT,
  });
}
