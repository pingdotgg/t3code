import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in queue editing tests"),
} satisfies ProviderAdapterV2["Service"];
export const layer = Layer.merge(
  ProviderReplayHarness.layerWithRegistry(
    { name: "queued-run-editing" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  ),
  ThreadCommandExecutor.layer,
);

// Park the terminal listener before it takes the thread lock, while allowing
// subsequent user commands through the real executor.
export const pauseTerminalListener = Effect.fnUntraced(function* (threadId: ThreadId) {
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const entered = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const handled = yield* Deferred.make<void>();
  const withLock = executor.withLock;
  let paused = false;
  let finalized = false;
  const intercept: typeof withLock = (key, effect) => {
    if (key !== threadId) return withLock(key, effect);
    if (paused) {
      return finalized
        ? withLock(key, effect).pipe(Effect.tap(() => Deferred.succeed(handled, undefined)))
        : withLock(key, effect);
    }
    paused = true;
    return Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(released)),
      Effect.andThen(withLock(key, effect)),
      Effect.tap(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      ),
    );
  };
  const spy = vi.spyOn(executor, "withLock").mockImplementation(intercept);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => spy.mockRestore()).pipe(
      Effect.andThen(Deferred.succeed(released, undefined)),
    ),
  );
  return {
    entered: Deferred.await(entered),
    release: Deferred.succeed(released, undefined),
    handled: Deferred.await(handled),
  };
});

export const createQueue = Effect.fnUntraced(function* (
  name: string,
  worktreePath: string | null = process.cwd(),
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}:create`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
  });
  for (const [index, text] of ["Active", "Original", "Later"].entries()) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${name}:message:${index}`),
      threadId,
      messageId: MessageId.make(`${name}:message:${index}`),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
    });
  }
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const [active, queued, later] = projection.runs;
  assert.isDefined(active);
  assert.isDefined(queued);
  assert.isDefined(later);
  const editId = CommandId.make(`${name}:begin`);
  const begin = {
    type: "queued-run.edit.begin" as const,
    commandId: editId,
    threadId,
    runId: queued.id,
    previousEditId: null,
  };
  const endActiveRun = Effect.fnUntraced(function* (
    reason: "completed" | "provider_error" | "validation_error" | "missing_worktree",
  ) {
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        ...(reason === "provider_error" || reason === "validation_error"
          ? [
              {
                id: EventId.make(`${name}:error`),
                type: "turn-item.updated" as const,
                threadId,
                runId: active.id,
                nodeId: active.rootNodeId!,
                providerInstanceId: active.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`${name}:error`),
                  type: "error" as const,
                  threadId,
                  runId: active.id,
                  nodeId: active.rootNodeId!,
                  providerThreadId: active.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed" as const,
                  title: "Provider failure",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    class: reason,
                    message: "Provider failed.",
                    code: "provider_failed",
                    retryable: null,
                  },
                },
              },
            ]
          : []),
        {
          id: EventId.make(`${name}:terminal`),
          type: "run.updated",
          threadId,
          runId: active.id,
          providerInstanceId: active.providerInstanceId,
          occurredAt: now,
          payload: {
            ...active,
            status:
              reason === "completed"
                ? "completed"
                : reason === "missing_worktree"
                  ? "interrupted"
                  : "failed",
            completedAt: now,
            ...(reason === "missing_worktree"
              ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
              : {}),
          },
        },
      ],
    });
  });
  const complete = endActiveRun("completed").pipe(Effect.andThen(orchestrator.resumeQueuedRuns));
  return { orchestrator, threadId, active, queued, later, editId, begin, complete, endActiveRun };
});
