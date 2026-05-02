import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const taskStatus = v.union(
  v.literal("ready"),
  v.literal("working"),
  v.literal("needs_input"),
  v.literal("ready_for_review"),
  v.literal("done"),
  v.literal("blocked"),
  v.literal("failed"),
  v.literal("canceled"),
);
const taskCreatedFrom = v.union(
  v.literal("workspace"),
  v.literal("linear"),
  v.literal("slack"),
  v.literal("support_email"),
  v.literal("webhook"),
);
const taskThreadRole = v.union(
  v.literal("primary"),
  v.literal("supporting"),
  v.literal("historical_primary"),
);
const taskExternalLinkKind = v.union(
  v.literal("linear_issue"),
  v.literal("slack_thread"),
  v.literal("support_email_thread"),
  v.literal("webhook_event"),
  v.literal("github_pr"),
);
const workSessionStatus = v.union(
  v.literal("requested"),
  v.literal("accepted"),
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("interrupted"),
  v.literal("superseded"),
);

export default defineSchema({
  projects: defineTable({
    repoName: v.string(),
    sandboxWorkspaceRoot: v.string(),
    defaultBranch: v.string(),
    githubOwner: v.string(),
    githubRepo: v.string(),
    linearTeamId: v.optional(v.string()),
    linearProjectId: v.optional(v.string()),
    t3ProjectId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_repo", ["githubOwner", "githubRepo"])
    .index("by_workspace_root", ["sandboxWorkspaceRoot"])
    .index("by_linear_team_project", ["linearTeamId", "linearProjectId"]),
  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    status: taskStatus,
    statusReason: v.optional(v.string()),
    currentPrimaryTaskThreadId: v.optional(v.id("taskThreads")),
    archivedAt: v.optional(v.number()),
    createdFrom: taskCreatedFrom,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project_status_updated", ["projectId", "status", "updatedAt"])
    .index("by_project_updated", ["projectId", "updatedAt"]),
  taskThreads: defineTable({
    taskId: v.id("tasks"),
    t3ThreadId: v.string(),
    t3ProjectId: v.optional(v.string()),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    role: taskThreadRole,
    codingAgent: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_t3_thread", ["t3ThreadId"]),
  taskExternalLinks: defineTable({
    taskId: v.id("tasks"),
    kind: taskExternalLinkKind,
    externalId: v.string(),
    url: v.optional(v.string()),
    muted: v.boolean(),
    syncCursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_kind_external_id", ["kind", "externalId"]),
  workSessions: defineTable({
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    t3ThreadId: v.string(),
    status: workSessionStatus,
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    updatedAt: v.number(),
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
    bridgeRunId: v.optional(v.string()),
  })
    .index("by_task_updated", ["taskId", "updatedAt"])
    .index("by_t3_thread", ["t3ThreadId"])
    .index("by_bridge_run", ["bridgeRunId"]),
  taskEvents: defineTable({
    taskId: v.id("tasks"),
    eventKey: v.optional(v.string()),
    kind: v.string(),
    summary: v.string(),
    payloadJson: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_task_created", ["taskId", "createdAt"])
    .index("by_event_key", ["eventKey"]),
});
