import type {
  OrchestrationV2CheckpointScope,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as EventStore from "./EventStore.ts";

// Scopes in commit order; a run's latest scope wins.
function nativeStorageFolder(input: {
  readonly providerThread: Pick<
    OrchestrationV2ProviderThread,
    "id" | "nativeThreadRef" | "nativeStorageFolder"
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "cwd">>;
  readonly attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "runId" | "providerThreadId" | "nativeThreadId">
  >;
  readonly checkpointScopes: ReadonlyArray<
    Pick<OrchestrationV2CheckpointScope, "kind" | "runId" | "providerThreadId" | "cwd">
  >;
}): string | undefined {
  const { providerThread } = input;
  if (providerThread.nativeStorageFolder !== undefined) return providerThread.nativeStorageFolder;
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  const sessionRunIds = new Set(
    input.attempts.flatMap((attempt) =>
      attempt.nativeThreadId !== undefined && attempt.nativeThreadId === nativeThreadId
        ? [attempt.runId]
        : [],
    ),
  );
  const rootScopes = new Map(
    input.checkpointScopes.flatMap((scope) =>
      scope.kind === "root_run" && scope.runId !== null ? [[scope.runId, scope] as const] : [],
    ),
  );
  const runs = [...input.runs].sort((left, right) => left.ordinal - right.ordinal);
  const scopes = runs.flatMap((run) => rootScopes.get(run.id) ?? []);
  const first = runs.find((run) => sessionRunIds.has(run.id));
  return (
    first?.cwd ??
    (first && rootScopes.get(first.id)?.cwd) ??
    (input.attempts.some(
      (attempt) =>
        attempt.providerThreadId === providerThread.id && attempt.nativeThreadId !== undefined,
    )
      ? undefined
      : scopes.find((scope) => scope.providerThreadId === providerThread.id)?.cwd)
  );
}

export const nativeStorageFolders = Effect.fn("NativeStorageFolder.nativeStorageFolders")(
  function* (
    eventStore: Pick<EventStore.EventStoreV2Shape, "read">,
    threadId: ThreadId,
    records: Pick<Parameters<typeof nativeStorageFolder>[0], "runs" | "attempts"> & {
      readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
    },
  ) {
    const scopes = yield* Effect.cached(
      Effect.suspend(() =>
        eventStore.read({ threadId, eventType: "checkpoint-scope.created" }).pipe(
          Stream.runCollect,
          Effect.map((events) =>
            events.flatMap(({ event }) =>
              event.type === "checkpoint-scope.created" ? [event.payload] : [],
            ),
          ),
        ),
      ),
    );
    const folders = new Map<ProviderThreadId, string>();
    for (const providerThread of records.providerThreads) {
      if (providerThread.driver !== "claudeAgent") continue;
      const folder =
        nativeStorageFolder({ ...records, providerThread, checkpointScopes: [] }) ??
        nativeStorageFolder({ ...records, providerThread, checkpointScopes: yield* scopes });
      if (folder !== undefined) folders.set(providerThread.id, folder);
    }
    return folders;
  },
);
