// Approval plugins must match the whole operation narrowly and abstain otherwise; shell prefixes are insufficient.
// Answers race with the user through the orchestrator’s authoritative pending-request guard.
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, RunId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";

/** The manifest capability a plugin declares to answer approvals. */
export const PLUGIN_APPROVALS_CAPABILITY = "approvals";

/** The handler the server calls; plugins register it with `context.proposed.handle`. */
export const PLUGIN_APPROVAL_HANDLER = "t3.approval.decide";

export const PLUGIN_APPROVAL_LIMITS = {
  defaultTimeoutSeconds: 15,
  maxTimeoutSeconds: 120,
  /**
   * Longest `prompt` or `subject` a plugin receives, in UTF-16 code units. A
   * request with a longer one is not offered to plugins; it waits for the user.
   */
  maxPromptLength: 8000,
  maxReasonLength: 500,
} as const;

/**
 * The provider requests a plugin may answer: running a command, reading or
 * changing files, and other tool permissions. MCP elicitations, questions,
 * and sign-in requests are not offered to plugins.
 */
export const PluginApprovalKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "permission",
]);
export type PluginApprovalKind = typeof PluginApprovalKind.Type;

/** The manifest's `approvals` object; needs the `approvals` capability. */
export const PluginApprovalDeclaration = Schema.Struct({
  kinds: Schema.Array(PluginApprovalKind).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  /** How long the plugin may take to answer once it runs; default 15. */
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PLUGIN_APPROVAL_LIMITS.maxTimeoutSeconds }),
    ),
  ),
});
export type PluginApprovalDeclaration = typeof PluginApprovalDeclaration.Type;

// Prompt and subject are untrusted agent/user content, delivered whole.
// Without a concrete subject, policies requiring the operation must abstain.
export const PluginApprovalRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: PluginApprovalKind,
  prompt: Schema.String.check(Schema.isMaxLength(PLUGIN_APPROVAL_LIMITS.maxPromptLength)),
  subject: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PLUGIN_APPROVAL_LIMITS.maxPromptLength)),
  ),
  context: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    /** The provider driver that asked, such as `codex` or `claudeAgent`. */
    provider: Schema.NullOr(Schema.String),
  }),
});
export type PluginApprovalRequest = typeof PluginApprovalRequest.Type;

/**
 * What the handler returns. `approve` allows this one request, `deny` declines
 * it, and `abstain` (or `null`) leaves it to the user. `reason` is shown in the
 * thread next to the decision.
 */
export const PluginApprovalAnswer = Schema.NullOr(
  Schema.Struct({
    decision: Schema.Literals(["approve", "deny", "abstain"]),
    reason: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(PLUGIN_APPROVAL_LIMITS.maxReasonLength)),
    ),
  }),
);
export type PluginApprovalAnswer = typeof PluginApprovalAnswer.Type;
