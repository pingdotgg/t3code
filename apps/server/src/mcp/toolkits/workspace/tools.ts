import {
  ApprovalRequestId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceMcpError } from "./errors.ts";
import { WORKSPACE_THREAD_SHELVES, WORKSPACE_THREAD_STATUSES } from "./mapping.ts";
import { WorkspaceMcpAuth } from "./principal.ts";

const dependencies = [
  WorkspaceMcpAuth,
  ProjectionSnapshotQuery,
  OrchestrationEngineService,
  ProviderRegistry,
  Crypto.Crypto,
];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutateTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

const WorkspaceThreadShelf = Schema.Literals(WORKSPACE_THREAD_SHELVES);
const WorkspaceThreadStatus = Schema.Literals(WORKSPACE_THREAD_STATUSES);

const ProjectBrief = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultProvider: Schema.NullOr(Schema.String),
  defaultModel: Schema.NullOr(Schema.String),
});

const ThreadBrief = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  shelf: WorkspaceThreadShelf,
  status: WorkspaceThreadStatus,
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  sessionStatus: Schema.NullOr(Schema.String),
  latestTurnState: Schema.NullOr(Schema.String),
  planStep: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  createdAt: Schema.String,
});

const ThreadDetail = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  shelf: WorkspaceThreadShelf,
  status: WorkspaceThreadStatus,
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  runtimeMode: Schema.String,
  interactionMode: Schema.String,
  sessionStatus: Schema.NullOr(Schema.String),
  latestTurnState: Schema.NullOr(Schema.String),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  pendingApprovals: Schema.Array(
    Schema.Struct({
      requestId: Schema.String,
      detail: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  ),
  messages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      streaming: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
  activities: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      tone: Schema.String,
      summary: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  proposedPlans: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      planMarkdown: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  hasMore: Schema.Boolean,
  beforeCursor: Schema.NullOr(Schema.String),
});

const ProviderBrief = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      isDefault: Schema.Boolean,
    }),
  ),
});

export const ListProjectsTool = readonlyTool(
  Tool.make("list_projects", {
    description:
      "List T3 Code projects on this environment. Each project is a workspace directory that can hold many threads. Optional query matches title or path.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    success: Schema.Struct({ projects: Schema.Array(ProjectBrief) }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const CreateProjectTool = mutateTool(
  Tool.make("create_project", {
    description:
      "Create a T3 Code project rooted at a directory on this environment's machine. workspaceRoot is a filesystem path on the T3 server, not on the ChatGPT device.",
    parameters: Schema.Struct({
      title: TrimmedNonEmptyString,
      workspaceRoot: TrimmedNonEmptyString,
      createWorkspaceRootIfMissing: Schema.optionalKey(Schema.Boolean).pipe(
        Schema.withDecodingDefault(Effect.succeed(true)),
      ),
    }),
    success: Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
      workspaceRoot: Schema.String,
    }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Create project"),
);

export const ListThreadsTool = readonlyTool(
  Tool.make("list_threads", {
    description:
      "List sidebar threads with shelf (active, settled, snoozed, archived) and live status (working, pending-approval, completed, idle, and similar). Defaults to every non-archived thread.",
    parameters: Schema.Struct({
      projectId: Schema.optionalKey(ProjectId),
      shelf: Schema.optionalKey(Schema.Union([WorkspaceThreadShelf, Schema.Literal("all")])),
      status: Schema.optionalKey(WorkspaceThreadStatus),
      includeArchived: Schema.optionalKey(Schema.Boolean).pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
      ),
    }),
    success: Schema.Struct({ threads: Schema.Array(ThreadBrief) }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "List threads"),
);

export const GetThreadTool = readonlyTool(
  Tool.make("get_thread", {
    description:
      "Read an existing T3 thread so you can summarize it. Returns messages, activity log, proposed plans, and pending approvals. Use beforeCursor when hasMore is true to load older turns. Do not read the raw transcript aloud — summarize in 2–4 spoken sentences.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      turnLimit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      ).pipe(Schema.withDecodingDefault(Effect.succeed(40))),
      beforeCursor: Schema.optionalKey(Schema.String),
    }),
    success: ThreadDetail,
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Read thread"),
);

export const ListProvidersTool = readonlyTool(
  Tool.make("list_providers", {
    description:
      "List configured T3 providers and models that can start a new thread, such as Codex, Claude, Cursor, Grok, and OpenCode.",
    parameters: Schema.Struct({
      includeDisabled: Schema.optionalKey(Schema.Boolean).pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
      ),
    }),
    success: Schema.Struct({ providers: Schema.Array(ProviderBrief) }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "List providers"),
);

export const StartThreadTool = mutateTool(
  Tool.make("start_thread", {
    description:
      "Create a new T3 thread in a project and send the first user prompt to the chosen provider and model. Omit provider/model to use the project default.",
    parameters: Schema.Struct({
      projectId: ProjectId,
      prompt: Schema.String.check(Schema.isNonEmpty()),
      title: Schema.optionalKey(TrimmedNonEmptyString),
      provider: Schema.optionalKey(TrimmedNonEmptyString),
      instanceId: Schema.optionalKey(TrimmedNonEmptyString),
      model: Schema.optionalKey(TrimmedNonEmptyString),
      runtimeMode: Schema.optionalKey(RuntimeMode).pipe(
        Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
      ),
      interactionMode: Schema.optionalKey(ProviderInteractionMode).pipe(
        Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
      ),
    }),
    success: Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      provider: Schema.String,
      model: Schema.String,
    }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Start thread"),
);

export const FollowUpTool = mutateTool(
  Tool.make("follow_up", {
    description:
      "Send a follow-up user message on an existing T3 thread and continue the agent turn.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      prompt: Schema.String.check(Schema.isNonEmpty()),
    }),
    success: Schema.Struct({
      threadId: Schema.String,
      accepted: Schema.Boolean,
    }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Follow up on thread"),
);

export const InterruptThreadTool = mutateTool(
  Tool.make("interrupt_thread", {
    description: "Stop the in-progress agent turn on a T3 thread.",
    parameters: Schema.Struct({
      threadId: ThreadId,
    }),
    success: Schema.Struct({
      threadId: Schema.String,
      accepted: Schema.Boolean,
    }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Interrupt thread"),
);

export const SettleThreadTool = Tool.make("settle_thread", {
  description:
    "Settle a finished thread only when the user asks, preserving history and artifacts. A request to archive a finished task means settle. Active turns, pending requests, queued starts and archived threads conflict. No deferred or self-settle during a turn.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({
    threadId: Schema.String,
    shelf: Schema.Literal("settled"),
    status: WorkspaceThreadStatus,
    settledAt: Schema.String,
    alreadySettled: Schema.Boolean,
  }),
  failure: WorkspaceMcpError,
  dependencies,
})
  .annotate(Tool.Title, "Settle thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const UnsettleThreadTool = Tool.make("unsettle_thread", {
  description:
    "Return a settled thread to the active shelf when the user asks. Preserves history and does not send a message or start an agent turn. Safe to repeat for an already active thread.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({
    threadId: Schema.String,
    shelf: Schema.Literal("active"),
    status: WorkspaceThreadStatus,
    unsettled: Schema.Literal(true),
  }),
  failure: WorkspaceMcpError,
  dependencies,
})
  .annotate(Tool.Title, "Unsettle thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const RespondToApprovalTool = mutateTool(
  Tool.make("respond_to_approval", {
    description:
      "Approve or decline a pending agent approval. Restate the risk to the user and wait for an explicit yes before calling this with accept.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      confirmed: Schema.optionalKey(Schema.Boolean).pipe(
        Schema.withDecodingDefault(Effect.succeed(false)),
      ),
    }),
    success: Schema.Struct({
      threadId: Schema.String,
      requestId: Schema.String,
      decision: ProviderApprovalDecision,
    }),
    failure: WorkspaceMcpError,
    dependencies,
  }).annotate(Tool.Title, "Respond to approval"),
);

export const WorkspaceToolkit = Toolkit.make(
  ListProjectsTool,
  CreateProjectTool,
  ListThreadsTool,
  GetThreadTool,
  ListProvidersTool,
  StartThreadTool,
  FollowUpTool,
  InterruptThreadTool,
  RespondToApprovalTool,
  SettleThreadTool,
  UnsettleThreadTool,
);
