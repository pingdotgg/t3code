/**
 * TaskOrchestrator - server-side fan-out for agent-delegated sub-tasks.
 *
 * Delegation is split into two non-blocking steps so no single MCP tool call
 * outlives the provider's request timeout:
 *
 *   - `startTasks` routes each sub-task to a model, spawns a child thread per
 *     sub-task in the lead's working directory, kicks off its turn, and returns
 *     immediately with one `status: "running"` (or `"error"`) handle per task.
 *   - `collectTasks` polls the given child threads up to a bounded deadline and
 *     returns their final messages, leaving any that are still going as
 *     `status: "running"` so the caller can collect them again later.
 *
 * Spawned children are tracked in-memory (with their lead + routed model) so
 * the `delegate_tasks` tool can refuse delegation from an already-delegated
 * child (depth-1 recursion guard) and `collect_delegated_tasks` can resolve a
 * lead's outstanding children.
 *
 * @module TaskOrchestrator
 */
import type { DelegateTaskInput, DelegateTasksResult, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TaskOrchestratorStartInput {
  readonly parentThreadId: ThreadId;
  readonly tasks: ReadonlyArray<DelegateTaskInput>;
  readonly maxConcurrency?: number | undefined;
}

export interface TaskOrchestratorCollectInput {
  /** Child threads to collect. When omitted, every running child of the lead. */
  readonly threadIds?: ReadonlyArray<ThreadId> | undefined;
  /** Lead thread, used to scope an omitted `threadIds` to its own children. */
  readonly parentThreadId: ThreadId;
  /** Max time to wait for still-running children before returning. */
  readonly waitMs: number;
}

export interface TaskOrchestratorShape {
  /**
   * Spawn a child thread per sub-task and start its turn. Returns immediately
   * with a handle per task (`status: "running"`, or `"error"` if spawning
   * failed). Never blocks on completion.
   */
  readonly startTasks: (input: TaskOrchestratorStartInput) => Effect.Effect<DelegateTasksResult>;
  /**
   * Poll the given child threads up to `waitMs` and return their results;
   * children still running at the deadline come back as `status: "running"`.
   */
  readonly collectTasks: (
    input: TaskOrchestratorCollectInput,
  ) => Effect.Effect<DelegateTasksResult>;
  /** True if `threadId` was spawned as a delegated child during this process. */
  readonly isDelegatedChild: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class TaskOrchestrator extends Context.Service<TaskOrchestrator, TaskOrchestratorShape>()(
  "t3/orchestration/Services/TaskOrchestrator",
) {}
