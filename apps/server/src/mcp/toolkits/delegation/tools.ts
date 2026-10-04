import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import { TrimmedNonEmptyString } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DELEGATION_PROMPT_BLOCKS } from "../../../delegationPrompt.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";

/**
 * Input shapes mirror the legacy `delegate_work` JSON contract in
 * `apps/server/src/mcpServer.ts` field for field (descriptions included),
 * so the advertised contract stays identical. Values the legacy JSON contract
 * constrains — known prompt blocks, unique blocks, non-blank strings — are
 * constrained here too, so the gateway rejects them before an audit record is
 * created. The legacy implementation remains the validation authority and
 * re-checks everything at runtime.
 */
const DelegationFollowUp = Schema.Literals(["automatic", "notify-only"]);
const DelegationWait = Schema.Literals(["all", "any", "none"]);
const DelegationReasoning = Schema.Literals(["low", "medium", "high", "xhigh"]);

const DelegationWorkspace = Schema.Struct({
  mode: Schema.Literal("isolated"),
  branch: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  baseRef: Schema.optional(Schema.String),
});

const DelegationPromptTemplate = Schema.Struct({
  blocks: Schema.Array(Schema.Literals([...DELEGATION_PROMPT_BLOCKS])).check(
    Schema.isMinLength(1),
    Schema.isUnique(),
  ),
  repository: Schema.optional(
    Schema.Struct({
      context: Schema.optional(Schema.String),
      instructionFiles: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  validation: Schema.optional(
    Schema.Struct({
      commands: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
        Schema.isMinLength(1),
      ),
      scenarios: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
      evidence: Schema.optional(
        Schema.Array(Schema.Literals(["screenshot", "recording"])).check(
          Schema.isMinLength(1),
          Schema.isUnique(),
        ),
      ),
      owner: Schema.optional(Schema.Literals(["child", "parent"])),
    }),
  ),
  commit: Schema.optional(
    Schema.Struct({
      requirements: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  pullRequest: Schema.optional(
    Schema.Struct({
      requirements: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
      ),
    }),
  ),
  reporting: Schema.optional(
    Schema.Struct({
      items: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
    }),
  ),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  additions: Schema.optional(
    Schema.Record(Schema.String, Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  ),
});

const DelegationDefaults = Schema.Struct({
  followUp: Schema.optional(DelegationFollowUp),
  project: Schema.optional(TrimmedNonEmptyString),
  promptTemplate: Schema.optional(DelegationPromptTemplate),
  model: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(DelegationReasoning),
  dryRun: Schema.optional(Schema.Boolean),
});

const DelegationChild = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  project: Schema.optional(TrimmedNonEmptyString),
  promptTemplate: Schema.optional(DelegationPromptTemplate),
  model: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(DelegationReasoning),
  dryRun: Schema.optional(Schema.Boolean),
  followUp: Schema.optional(DelegationFollowUp),
  workspace: Schema.optional(DelegationWorkspace),
});

export const DelegateWorkToolInput = Schema.Struct({
  defaults: Schema.optional(DelegationDefaults),
  children: Schema.Array(DelegationChild).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  concurrency: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
  ),
  wait: Schema.optional(DelegationWait),
});
export type DelegateWorkToolInput = typeof DelegateWorkToolInput.Type;

const ReportId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Summary = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000));

/**
 * `send_to_thread` without the tracked-assignment fields. Keep these two in
 * lockstep: `assign_to_thread` and `send_to_thread` share one legacy
 * implementation, and the only difference is whether the call becomes a
 * tracked assignment (`requestId` required) or a plain queued message.
 */
const CrossThreadMessageBase = {
  thread: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
};

export const SendToThreadToolInput = Schema.Struct({
  ...CrossThreadMessageBase,
  requestId: Schema.optional(ReportId),
  assignmentId: Schema.optional(TrimmedNonEmptyString),
  respondToReportId: Schema.optional(TrimmedNonEmptyString),
});

export const AssignToThreadToolInput = Schema.Struct({
  ...CrossThreadMessageBase,
  requestId: ReportId,
  followUp: Schema.optional(DelegationFollowUp),
});

export const ReportToParentToolInput = Schema.Struct({
  reportId: ReportId,
  kind: Schema.Literals(["progress", "decision-needed", "important-update"]),
  summary: Summary,
  assignmentId: TrimmedNonEmptyString,
  dispatchId: TrimmedNonEmptyString,
  decision: Schema.optional(
    Schema.Struct({
      question: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
      options: Schema.optional(
        Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(8)),
      ),
      recommendation: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
    }),
  ),
  canContinue: Schema.optional(Schema.Boolean),
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
  originTurnId: TrimmedNonEmptyString,
});

export const RespondToChildRequestToolInput = Schema.Struct({
  thread: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  decision: Schema.optional(Schema.Literals(["accept", "acceptForSession", "decline", "cancel"])),
  answers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type RespondToChildRequestToolInput = typeof RespondToChildRequestToolInput.Type;

/**
 * `condition` is optional rather than required-with-null on purpose. Pi's
 * extension strips `null` arguments before calling the tool, so a required
 * `null` would arrive as an absent key. An absent condition and an explicit
 * `null` both mean "restore automatic follow-up", which is already the
 * default, so the two are indistinguishable and harmless to conflate.
 */
export const SetChildWaitToolInput = Schema.Struct({
  condition: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        mode: Schema.Literals(["any", "all", "decisions-only"]),
        deadlineAt: Schema.optional(Schema.String),
        assignments: Schema.Array(
          Schema.Struct({
            childThreadId: TrimmedNonEmptyString,
            assignmentId: TrimmedNonEmptyString,
          }),
        ).check(Schema.isMaxLength(32)),
      }),
    ),
  ),
});

export const CreateIsolatedWorkspaceToolInput = Schema.Struct({
  branch: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  baseRef: Schema.optional(Schema.String),
});

export const SwitchWorkspaceToolInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});

export const PullRequestReferenceToolInput = Schema.Struct({
  reference: TrimmedNonEmptyString,
});

export class DelegationToolError extends Schema.TaggedErrorClass<DelegationToolError>()(
  "DelegationToolError",
  { message: Schema.String },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery,
  ProviderSessionDirectory,
  ServerConfig,
  ServerSettingsService,
];

export const DelegateWorkTool = Tool.make("delegate_work", {
  description:
    "Canonical delegation tool for one or many helper threads. Supply children with only title and prompt; shared project, model, reasoning, prompt template, follow-up policy, and dry-run settings belong in defaults and may be overridden per child. Project defaults to the authenticated parent workspace; model defaults to the settings delegated-thread model (factory Copilot gpt-6-luna). For automatic children, wait selects all, any, or no batch wait; the default is all when more than one automatic child is created and none for one child or notify-only work. The wait is installed atomically with child creation and revised to include only created assignments before this tool returns. T3 preserves input order, rejects workspace collisions before mutation, and returns indexed outcomes including partial failures.",
  parameters: DelegateWorkToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delegate work to helper threads")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SendToThreadTool = Tool.make("send_to_thread", {
  description:
    "Durably queue a prompt for an existing T3 thread from the authenticated current thread. Use this to reply to or follow up on a child that already exists — do not create another child to deliver a message. Returns a queuedTurnId immediately; delivery starts in queue order once the destination has no active turn or pending approval/input. Does not interrupt the destination or wait for completion. T3 records the initiating source message as provenance when queued; do not use terminal-based `t3 chat send` for cross-thread messaging.",
  parameters: SendToThreadToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send a prompt to an existing thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const AssignToThreadTool = Tool.make("assign_to_thread", {
  description:
    "Create a new tracked assignment in an existing child of this thread. The previous assignment must be finished and have no unresolved decision. Atomically queues the prompt and returns assignmentId, so T3 reports the result back to this parent. Reuse requestId on retry. For a decision response, use send_to_thread with respondToReportId instead.",
  parameters: AssignToThreadToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Assign new work to an existing child")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ReportToParentTool = Tool.make("report_to_parent", {
  description:
    "Report progress or an early decision/blocker to the authenticated child's parent. Progress never wakes the parent; actionable reports follow the parent's policy and never interrupt it. Reuse reportId when retrying the same report. Results and failures are reported automatically; do not send duplicate completion messages.",
  parameters: ReportToParentToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Report progress or a decision to the parent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const RespondToChildRequestTool = Tool.make("respond_to_child_request", {
  description:
    "Answer a pending approval or user-input request raised by one of this thread's own children. Child requests are routed to the parent instead of the user. For an approval pass decision (accept, acceptForSession, decline, or cancel); for a question pass answers keyed by question id. Decide within the user's original intent and your own permissions; if the request needs human judgement or exceeds that authority, alert the user instead of answering.",
  parameters: RespondToChildRequestToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Respond to a child's approval or question")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SetChildWaitTool = Tool.make("set_child_wait", {
  description:
    "Set when this parent should continue: any selected result, all selected results, or decisions/blockers only. Optionally set deadlineAt as an ISO timestamp; any assignments still unsettled at that deadline are reported as blocked without stopping the children. Pass null to restore automatic follow-up. Use exact assignment IDs from spawn/assignment results or chat show. Membership is fixed; partial spawn failures must be handled explicitly. Never interrupts an active turn or overrides Stop.",
  parameters: SetChildWaitToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set the parent child-wait condition")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const CreateIsolatedWorkspaceTool = Tool.make("create_isolated_workspace", {
  description:
    "Move the current calling thread to a new isolated checkout instead of running git worktree add directly. Creates a Git worktree, durably binds this T3 thread to it, and queues an automatic continuation. Never use this tool to prepare a workspace for a future delegated thread; pass workspace to delegate_work instead. After calling, do not edit the new worktree during the current turn; finish so T3 can restart in the bound workspace and continue automatically.",
  parameters: CreateIsolatedWorkspaceToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Move this thread to a new worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SwitchWorkspaceTool = Tool.make("switch_workspace", {
  description:
    "Required instead of running git worktree move/remove or editing another checkout directly when this thread must use an existing worktree. Validates that the path belongs to the same Git repository, durably binds the thread, and queues an automatic continuation. After calling, finish so T3 can restart there and continue automatically.",
  parameters: SwitchWorkspaceToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Move this thread to an existing worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const AssociatePullRequestTool = Tool.make("associate_pull_request", {
  description:
    "Durably associate a pull request with the authenticated current T3 thread. Call this after successfully creating or explicitly opening a PR for this thread. The URL or number is resolved through GitHub and persisted on the thread; never infer association from the current branch.",
  parameters: PullRequestReferenceToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Associate a pull request with this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const LinkPullRequestTool = Tool.make("link_pull_request", {
  description:
    "Link a pull request to the authenticated current T3 thread without changing its workspace pull request. The operation is idempotent.",
  parameters: PullRequestReferenceToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link a pull request to this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Unlink a pull request from the authenticated current T3 thread. The operation is idempotent.",
  parameters: PullRequestReferenceToolInput,
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink a pull request from this thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description: "List all pull requests linked to the authenticated current T3 thread.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: Schema.String,
  failure: DelegationToolError,
  dependencies,
})
  .annotate(Tool.Title, "List pull requests linked to this thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/**
 * The canonical cross-thread and delegation surface for every provider that
 * talks to the `t3-code` MCP server. Copilot reaches the same legacy
 * implementations through the `t3-tools` server, so both paths stay in
 * lockstep; a provider must never see a second, divergent `delegate_work`.
 */
export const DelegationToolkit = Toolkit.make(
  DelegateWorkTool,
  SendToThreadTool,
  AssignToThreadTool,
  ReportToParentTool,
  RespondToChildRequestTool,
  SetChildWaitTool,
  CreateIsolatedWorkspaceTool,
  SwitchWorkspaceTool,
  AssociatePullRequestTool,
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
);
