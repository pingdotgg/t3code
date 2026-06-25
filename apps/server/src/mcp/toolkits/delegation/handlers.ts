import type { DelegateTaskResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TaskOrchestrator } from "../../../orchestration/Services/TaskOrchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationToolkit } from "./tools.ts";

// Bounded wait kept comfortably under typical MCP client request timeouts so a
// single tool call never times out, even when sub-tasks take minutes. Slow
// sub-tasks come back 'running' and are picked up by collect_delegated_tasks.
const INLINE_WAIT_MS = 30_000;

const handlers = {
  delegate_tasks: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const orchestrator = yield* TaskOrchestrator;
      // Depth-1 recursion guard: a thread that was itself spawned as a
      // delegated sub-task may not delegate further.
      const isChild = yield* orchestrator.isDelegatedChild(scope.threadId);
      if (isChild) {
        return yield* Effect.fail({
          reason: "Delegated sub-tasks cannot delegate further (depth-1 limit).",
        });
      }
      const started = yield* orchestrator.startTasks({
        parentThreadId: scope.threadId,
        tasks: input.tasks,
        maxConcurrency: input.maxConcurrency,
      });
      const runningIds = started.results
        .filter((result) => result.status === "running")
        .map((result) => result.threadId);
      if (runningIds.length === 0) {
        return started;
      }
      // Wait a bounded time so fast sub-tasks come back inline; the rest stay
      // 'running' for collect_delegated_tasks to pick up later.
      const collected = yield* orchestrator.collectTasks({
        parentThreadId: scope.threadId,
        threadIds: runningIds,
        waitMs: INLINE_WAIT_MS,
      });
      const collectedByThread = new Map<string, DelegateTaskResult>(
        collected.results.map((result) => [result.threadId, result]),
      );
      const results = started.results.map((result) =>
        result.status === "error" ? result : (collectedByThread.get(result.threadId) ?? result),
      );
      return { results };
    }),
  collect_delegated_tasks: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const orchestrator = yield* TaskOrchestrator;
      return yield* orchestrator.collectTasks({
        parentThreadId: scope.threadId,
        threadIds: input.threadIds,
        waitMs: INLINE_WAIT_MS,
      });
    }),
} satisfies Parameters<typeof DelegationToolkit.toLayer>[0];

export const DelegationToolkitHandlersLive = DelegationToolkit.toLayer(handlers);
