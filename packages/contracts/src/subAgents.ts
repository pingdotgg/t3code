/**
 * Sub-agent orchestration contracts.
 *
 * Schemas for the product-native MCP "agents" toolkit that lets a running
 * provider session spawn and drive sibling threads on any configured
 * provider instance — including a different driver than its own (e.g. a
 * Claude session delegating a task to a Codex instance, or vice versa).
 *
 * Keep this module schema-only; the runtime lives in
 * `apps/server/src/mcp/toolkits/agents/`.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderAuthStatus, ServerProviderState } from "./server.ts";

/**
 * Maximum spawn nesting. A user-created thread sits at depth 0; each
 * sub-agent thread is one level deeper. Spawning is refused once the
 * caller is already at this depth, bounding recursive fan-out.
 */
export const SUB_AGENT_MAX_SPAWN_DEPTH = 2;

export const SubAgentStatus = Schema.Literals(["running", "completed", "interrupted", "error"]);
export type SubAgentStatus = typeof SubAgentStatus.Type;

export const SubAgentProviderSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  status: ServerProviderState,
  authStatus: ServerProviderAuthStatus,
  /** Whether `agent_spawn` currently accepts this instance as a target. */
  spawnable: Schema.Boolean,
  /** Model slugs accepted by `agent_spawn`'s `model` input. */
  models: Schema.Array(TrimmedNonEmptyString),
  /** True for the instance running the calling agent session. */
  isCaller: Schema.Boolean,
});
export type SubAgentProviderSummary = typeof SubAgentProviderSummary.Type;

export const SubAgentListResult = Schema.Struct({
  providers: Schema.Array(SubAgentProviderSummary),
});
export type SubAgentListResult = typeof SubAgentListResult.Type;

export const SubAgentSpawnInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId.annotate({
    description:
      "Target provider instance id from agent_list (may be a different agent than the caller, e.g. spawn Codex from Claude).",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "Initial task prompt for the sub-agent. Include all context it needs; it does not see this conversation.",
  }),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model slug from agent_list. Defaults to the target provider's first model.",
    }),
  ),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Thread title shown in the UI. Defaults to the first line of the prompt.",
    }),
  ),
});
export type SubAgentSpawnInput = typeof SubAgentSpawnInput.Type;

export const SubAgentSpawnResult = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  status: SubAgentStatus,
});
export type SubAgentSpawnResult = typeof SubAgentSpawnResult.Type;

export const SubAgentSendInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "Sub-agent thread id returned by agent_spawn in this session.",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description: "Follow-up prompt for the sub-agent's next turn.",
  }),
});
export type SubAgentSendInput = typeof SubAgentSendInput.Type;

export const SubAgentSendResult = Schema.Struct({
  threadId: ThreadId,
  status: SubAgentStatus,
});
export type SubAgentSendResult = typeof SubAgentSendResult.Type;

export const SubAgentWaitInput = Schema.Struct({
  threadId: ThreadId.annotate({
    description: "Sub-agent thread id returned by agent_spawn in this session.",
  }),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })).annotate({
      description:
        'Maximum seconds to block for the turn to finish (default 60). On timeout the result status is "running"; call agent_wait again to keep waiting.',
    }),
  ),
});
export type SubAgentWaitInput = typeof SubAgentWaitInput.Type;

export const SubAgentWaitResult = Schema.Struct({
  threadId: ThreadId,
  status: SubAgentStatus,
  /** Final assistant message of the awaited turn; null while running or when unavailable. */
  finalText: Schema.NullOr(Schema.String),
});
export type SubAgentWaitResult = typeof SubAgentWaitResult.Type;

export const SubAgentErrorReason = Schema.Literals([
  "capability-unavailable",
  "provider-not-found",
  "provider-not-spawnable",
  "model-not-resolved",
  "caller-thread-not-found",
  "thread-not-found",
  "depth-limit-exceeded",
  "dispatch-failed",
]);
export type SubAgentErrorReason = typeof SubAgentErrorReason.Type;

export class SubAgentError extends Schema.TaggedErrorClass<SubAgentError>()("SubAgentError", {
  reason: SubAgentErrorReason,
  description: Schema.String,
}) {
  override get message(): string {
    return this.description;
  }
}
