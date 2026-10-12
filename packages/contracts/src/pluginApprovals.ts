/**
 * PluginApprovals - Lets a plugin answer the approvals a provider asks for.
 *
 * A plugin declares the `approvals` capability (with `proposedApi: true`) and
 * the request kinds it wants in its manifest, and registers one handler:
 *
 * ```js
 * // Exactly these complete command lines; anything else, including
 * // `git status && rm -rf build`, is left to the user.
 * const READ_ONLY = new Set(["git status", "git diff"]);
 * export function activate(context) {
 *   context.proposed.handle("t3.approval.decide", ({ kind, subject }) =>
 *     kind === "command" && READ_ONLY.has(subject)
 *       ? { decision: "approve", reason: "Read-only git command." }
 *       : { decision: "abstain" },
 *   );
 * }
 * ```
 *
 * Match a whole, narrowly defined request and abstain from everything else: a
 * prefix of a shell command says nothing about the rest of it.
 *
 * When a provider asks to approve a request of a declared kind, the server
 * calls the handler of every enabled plugin that declares it, all at once. The
 * user can answer the request in the app at any time. The first answer the
 * server records wins, whether it came from the user or a plugin; later
 * answers change nothing, and plugins still deciding are cancelled.
 *
 * `abstain`, `null`, an invalid answer, a failure, a crash, the deadline, and
 * disabling the plugin all leave the request pending for the user. A plugin
 * never approves anything by failing, and never decides on part of a request:
 * when its prompt or subject is longer than `maxPromptLength`, no plugin is
 * asked, nor about a request whose approval card has no prompt.
 *
 * Plugins see only the approvals providers raise; this is not an interception
 * layer. Full-access normally bypasses provider tool approval gates, but
 * explicit extension or runtime confirmation requests can still reach T3
 * (including Pi's) and are offered like any other.
 *
 * @module PluginApprovals
 */
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

/**
 * What the handler receives. `prompt` is what the provider asked, as the
 * approval card shows it: a command, a path, a tool's description, or the
 * provider's reason; it is always present. `subject` is the tool call the
 * approval is for, as the thread shows it, when the provider reported one
 * first: the command line, the changed paths (one per line), or the tool name
 * and its JSON input. Both are user and agent content and may contain
 * anything the agent wrote. Both are sent whole, never cut. Without a
 * `subject` the plugin has only the prompt, which may be a description rather
 * than the operation; a policy that needs the operation should abstain then.
 */
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
