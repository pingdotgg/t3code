/**
 * Delegation contracts for the product-native MCP "agents" toolkit.
 *
 * A running provider session can delegate a self-contained task to a child
 * thread through `delegate_task`, then observe it through
 * `wait_for_delegate`. The child always runs on
 * the caller's own provider instance, model, effort, runtime mode, project,
 * and worktree — nothing is selectable — which keeps delegation
 * deterministic and token-cheap. Depth is capped at 1 and concurrency at a
 * small constant, so fan-out is bounded by construction.
 *
 * Keep this module schema-only; the runtime lives in
 * `apps/server/src/mcp/toolkits/agents/`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Maximum delegation nesting: user-created threads sit at depth 0 and their
 * delegated children at depth 1. Enforced structurally — a thread whose
 * `parentThreadId` is set is refused by `delegate_task`, so recursive
 * fan-out is impossible.
 */
/** Maximum concurrently running delegated children per parent thread. */
export const DELEGATE_MAX_CHILDREN_PER_PARENT = 3;
/** Maximum concurrently running delegated children across the whole server. */
export const DELEGATE_MAX_RUNNING_SERVER_WIDE = 10;
/** Character cap applied to the child result returned to the caller. */
export const DELEGATE_RESULT_MAX_CHARS = 8_000;

export const SubAgentStatus = Schema.Literals(["running", "completed", "interrupted", "error"]);
export type SubAgentStatus = typeof SubAgentStatus.Type;

/**
 * Strip C0/C1 control characters (including newlines) and collapse internal
 * whitespace so agent names are safe for thread titles like `Agent: <name>`.
 */
export const sanitizeSubAgentName = (value: string): string =>
  value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Optional short agent name: trimmed, control-stripped, non-empty after sanitize. */
export const SubAgentName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(sanitizeSubAgentName(value)),
      encode: (value) => Effect.succeed(value),
    }),
  ),
).check(Schema.isNonEmpty());
export type SubAgentName = typeof SubAgentName.Type;

export const DelegateTaskInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "Complete, self-contained task for the delegated agent. It does not see this conversation, so include all context it needs.",
  }),
  name: Schema.optional(
    SubAgentName.annotate({
      description:
        "Short label shown in the UI for the delegated task. Control characters and internal whitespace runs are sanitized.",
    }),
  ),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const DelegateTaskResult = Schema.Struct({
  /** Task id of the delegation row in the calling thread's timeline. */
  taskId: TrimmedNonEmptyString,
  /** Child thread that executed the task (persisted; transcript viewable in the UI). */
  threadId: ThreadId,
  status: SubAgentStatus,
  /** Final assistant message of the child turn; empty when unavailable. */
  result: Schema.String,
  /** True when `result` was truncated to DELEGATE_RESULT_MAX_CHARS. */
  truncated: Schema.Boolean,
});
export type DelegateTaskResult = typeof DelegateTaskResult.Type;

export const DelegateTaskStatusInput = Schema.Struct({
  /** Task id returned by delegate_task. */
  taskId: TrimmedNonEmptyString,
  /**
   * How long to wait for a state change before returning the current running
   * status. Kept short so provider MCP clients never depend on one fragile,
   * many-minute HTTP request.
   */
  waitSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })).annotate({
      description: "Seconds to wait for completion before returning the current status (0-30).",
      default: 20,
    }),
  ),
});
export type DelegateTaskStatusInput = typeof DelegateTaskStatusInput.Type;

export const DelegateErrorReason = Schema.Literals([
  "capability-unavailable",
  "caller-thread-not-found",
  "depth-limit-exceeded",
  "concurrency-limit-exceeded",
  "dispatch-failed",
  "task-not-found",
]);
export type DelegateErrorReason = typeof DelegateErrorReason.Type;

export class DelegateError extends Schema.TaggedErrorClass<DelegateError>()("DelegateError", {
  reason: DelegateErrorReason,
  description: Schema.String,
}) {
  override get message(): string {
    return this.description;
  }
}
