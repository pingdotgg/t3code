import { v } from "convex/values";

import { isValidTaskStatusTransition } from "../src/domain/taskStatus.ts";
import type { TaskStatus } from "../src/domain/taskStatus.ts";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";

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
const taskIntakeSource = v.union(
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
const linkKind = v.union(
  v.literal("linear_issue"),
  v.literal("slack_thread"),
  v.literal("support_email_thread"),
  v.literal("webhook_event"),
  v.literal("github_pr"),
);

function taskReturn() {
  return v.object({
    id: v.id("tasks"),
    projectId: v.id("projects"),
    title: v.string(),
    status: taskStatus,
    statusReason: v.optional(v.string()),
    currentPrimaryTaskThreadId: v.optional(v.id("taskThreads")),
    archivedAt: v.optional(v.number()),
    createdFrom: taskCreatedFrom,
    createdAt: v.number(),
    updatedAt: v.number(),
  });
}

function taskTreeReturn() {
  return v.array(
    v.object({
      project: v.object({
        id: v.id("projects"),
        repoName: v.string(),
        sandboxWorkspaceRoot: v.string(),
        defaultBranch: v.string(),
        githubOwner: v.string(),
        githubRepo: v.string(),
        t3ProjectId: v.optional(v.string()),
      }),
      tasks: v.array(
        v.object({
          id: v.id("tasks"),
          title: v.string(),
          status: taskStatus,
          statusReason: v.optional(v.string()),
          createdFrom: taskCreatedFrom,
          updatedAt: v.number(),
          archivedAt: v.optional(v.number()),
          primaryThread: v.optional(taskThreadTreeReturn()),
          threads: v.array(taskThreadTreeReturn()),
          externalLinks: v.array(taskExternalLinkTreeReturn()),
        }),
      ),
    }),
  );
}

function taskThreadTreeReturn() {
  return v.object({
    id: v.id("taskThreads"),
    t3ThreadId: v.string(),
    t3ProjectId: v.optional(v.string()),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    role: taskThreadRole,
    codingAgent: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  });
}

function taskExternalLinkTreeReturn() {
  return v.object({
    id: v.id("taskExternalLinks"),
    kind: linkKind,
    externalId: v.string(),
    url: v.optional(v.string()),
    muted: v.boolean(),
    syncCursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  });
}

function toTask(row: any) {
  return {
    id: row._id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    ...(row.statusReason !== undefined ? { statusReason: row.statusReason } : {}),
    ...(row.currentPrimaryTaskThreadId !== undefined
      ? { currentPrimaryTaskThreadId: row.currentPrimaryTaskThreadId }
      : {}),
    ...(row.archivedAt !== undefined ? { archivedAt: row.archivedAt } : {}),
    createdFrom: row.createdFrom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createTask = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    createdFrom: taskCreatedFrom,
    status: v.optional(taskStatus),
    statusReason: v.optional(v.string()),
    externalLinks: v.optional(
      v.array(
        v.object({
          kind: linkKind,
          externalId: v.string(),
          url: v.optional(v.string()),
          muted: v.optional(v.boolean()),
          syncCursor: v.optional(v.string()),
        }),
      ),
    ),
  },
  returns: taskReturn(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null) {
      throw new Error(`Project ${args.projectId} does not exist`);
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      projectId: args.projectId,
      title: args.title,
      status: args.status ?? "ready",
      createdFrom: args.createdFrom,
      createdAt: now,
      updatedAt: now,
      ...(args.statusReason !== undefined ? { statusReason: args.statusReason } : {}),
    });

    await ctx.db.insert("taskEvents", {
      taskId,
      kind: "task.created",
      summary: `Task created from ${args.createdFrom}.`,
      createdAt: now,
    });

    for (const link of args.externalLinks ?? []) {
      await ctx.db.insert("taskExternalLinks", {
        taskId,
        kind: link.kind,
        externalId: link.externalId,
        muted: link.muted ?? false,
        createdAt: now,
        updatedAt: now,
        ...(link.url !== undefined ? { url: link.url } : {}),
        ...(link.syncCursor !== undefined ? { syncCursor: link.syncCursor } : {}),
      });
    }

    const task = await ctx.db.get(taskId);
    return toTask(task);
  },
});

export const resolveTaskIntakeMessage = internalMutation({
  args: {
    eventId: v.string(),
    source: taskIntakeSource,
    externalLinkKind: linkKind,
    externalId: v.string(),
    title: v.string(),
    text: v.string(),
    url: v.optional(v.string()),
    teamId: v.optional(v.string()),
    channelId: v.optional(v.string()),
    issueId: v.optional(v.string()),
    commentId: v.optional(v.string()),
    messageId: v.string(),
    actorDisplayName: v.optional(v.string()),
    receivedAt: v.string(),
  },
  returns: v.union(
    v.object({
      status: v.literal("duplicate"),
      taskId: v.optional(v.id("tasks")),
    }),
    v.object({
      status: v.literal("created"),
      taskId: v.id("tasks"),
      projectId: v.id("projects"),
    }),
    v.object({
      status: v.literal("routed_existing"),
      taskId: v.id("tasks"),
      projectId: v.id("projects"),
      t3ThreadId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventId))
      .unique();
    if (existingEvent !== null) {
      return {
        status: "duplicate" as const,
        taskId: existingEvent.taskId,
      };
    }

    const existingLink = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", args.externalLinkKind).eq("externalId", args.externalId),
      )
      .unique();
    if (existingLink !== null) {
      const task = await ctx.db.get(existingLink.taskId);
      if (task === null) {
        throw new Error(`Linked Task ${existingLink.taskId} does not exist`);
      }

      const primaryThread =
        task.currentPrimaryTaskThreadId === undefined
          ? null
          : await ctx.db.get(task.currentPrimaryTaskThreadId);
      const now = Date.now();
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        eventKey: args.eventId,
        kind: "task-intake.follow-up",
        summary: `Follow-up received from ${args.source}.`,
        payloadJson: JSON.stringify(taskIntakeEventPayload(args)),
        createdAt: now,
      });
      await ctx.db.patch(task._id, {
        updatedAt: now,
      });

      return {
        status: "routed_existing" as const,
        taskId: task._id,
        projectId: task.projectId,
        ...(primaryThread?.t3ThreadId !== undefined
          ? { t3ThreadId: primaryThread.t3ThreadId }
          : {}),
      };
    }

    const project = await resolveProjectForTaskIntake(ctx, args.source, args.teamId);
    if (project === null) {
      throw new Error(
        args.teamId
          ? `No Project is configured for ${args.source} team ${args.teamId}`
          : `No default Project is configured for ${args.source} ingress`,
      );
    }

    const now = Date.now();
    const taskId = await ctx.db.insert("tasks", {
      projectId: project._id,
      title: args.title || `${args.source} task`,
      status: "ready",
      createdFrom: args.source,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("taskExternalLinks", {
      taskId,
      kind: args.externalLinkKind,
      externalId: args.externalId,
      muted: false,
      createdAt: now,
      updatedAt: now,
      ...(args.url !== undefined ? { url: args.url } : {}),
    });

    await ctx.db.insert("taskEvents", {
      taskId,
      eventKey: args.eventId,
      kind: "task-intake.created",
      summary: `Task created from ${args.source}.`,
      payloadJson: JSON.stringify(taskIntakeEventPayload(args)),
      createdAt: now,
    });

    return {
      status: "created" as const,
      taskId,
      projectId: project._id,
    };
  },
});

export const ensureTaskFromLinearIngress = internalMutation({
  args: {
    eventId: v.string(),
    issueId: v.string(),
    issueIdentifier: v.optional(v.string()),
    teamId: v.optional(v.string()),
    title: v.optional(v.string()),
    body: v.string(),
    commentUrl: v.optional(v.string()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    projectId: v.id("projects"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existingLink = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", "linear_issue").eq("externalId", args.issueId),
      )
      .unique();
    if (existingLink !== null) {
      const task = await ctx.db.get(existingLink.taskId);
      if (task === null) {
        throw new Error(`Linked Task ${existingLink.taskId} does not exist`);
      }
      return {
        taskId: task._id,
        projectId: task.projectId,
        created: false,
      };
    }

    const project = await resolveProjectForLinear(ctx, args.teamId);
    if (project === null) {
      throw new Error(
        args.teamId
          ? `No Project is configured for Linear team ${args.teamId}`
          : "No default Project is configured for Linear ingress",
      );
    }

    const now = Date.now();
    const title = (args.title ?? args.issueIdentifier ?? args.body.slice(0, 80)) || "Linear Task";
    const taskId = await ctx.db.insert("tasks", {
      projectId: project._id,
      title,
      status: "ready",
      createdFrom: "linear",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("taskExternalLinks", {
      taskId,
      kind: "linear_issue",
      externalId: args.issueId,
      muted: false,
      createdAt: now,
      updatedAt: now,
      ...(args.commentUrl !== undefined ? { url: args.commentUrl } : {}),
    });

    await ctx.db.insert("taskEvents", {
      taskId,
      eventKey: args.eventId,
      kind: "task.created.linear",
      summary: "Task created from Linear assignment.",
      payloadJson: JSON.stringify({
        issueId: args.issueId,
        ...(args.issueIdentifier !== undefined ? { issueIdentifier: args.issueIdentifier } : {}),
        ...(args.teamId !== undefined ? { teamId: args.teamId } : {}),
      }),
      createdAt: now,
    });

    return {
      taskId,
      projectId: project._id,
      created: true,
    };
  },
});

export const updateTaskStatus = mutation({
  args: {
    taskId: v.id("tasks"),
    status: taskStatus,
    statusReason: v.optional(v.string()),
  },
  returns: taskReturn(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const now = Date.now();
    const transition = isValidTaskStatusTransition({
      from: task.status as TaskStatus,
      to: args.status as TaskStatus,
    });
    if (!transition.allowed) {
      throw new Error(transition.reason ?? `Invalid Task status transition to ${args.status}`);
    }

    await ctx.db.patch(args.taskId, {
      status: args.status,
      updatedAt: now,
      ...(args.statusReason !== undefined ? { statusReason: args.statusReason } : {}),
      ...(args.status === "done" || args.status === "canceled" ? { archivedAt: now } : {}),
    });

    if (task.status !== args.status) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        kind: "status.changed",
        summary: `Task status changed from ${task.status} to ${args.status}.`,
        payloadJson: JSON.stringify({
          from: task.status,
          to: args.status,
          ...(args.statusReason !== undefined ? { reason: args.statusReason } : {}),
        }),
        createdAt: now,
      });
    }

    const updated = await ctx.db.get(args.taskId);
    return toTask(updated);
  },
});

export const markTaskIntakeStartFailed = internalMutation({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    source: taskIntakeSource,
    summary: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const now = Date.now();
    await ctx.db.patch(args.taskId, {
      status: "failed",
      statusReason: args.summary,
      updatedAt: now,
    });

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: `${args.eventId}:start-failed`,
      kind: "task-intake.start-failed",
      summary: `Task Intake failed to start runtime for ${args.source}.`,
      payloadJson: JSON.stringify({ source: args.source, summary: args.summary }),
      createdAt: now,
    });

    return null;
  },
});

export const getTaskIntakeLifecycleReplySeed = internalQuery({
  args: { taskId: v.id("tasks") },
  returns: v.union(
    v.null(),
    v.object({
      taskId: v.id("tasks"),
      source: taskIntakeSource,
      externalLinkKind: linkKind,
      externalId: v.string(),
      muted: v.boolean(),
      t3ThreadId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return null;
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const link =
      links.find((candidate) => candidate.kind === "linear_issue") ??
      links.find((candidate) => candidate.kind === "slack_thread");
    if (link === undefined) {
      return null;
    }

    const primaryThread =
      task.currentPrimaryTaskThreadId === undefined
        ? null
        : await ctx.db.get(task.currentPrimaryTaskThreadId);

    return {
      taskId: task._id,
      source: link.kind === "linear_issue" ? ("linear" as const) : ("slack" as const),
      externalLinkKind: link.kind,
      externalId: link.externalId,
      muted: link.muted ?? false,
      ...(primaryThread?.t3ThreadId !== undefined ? { t3ThreadId: primaryThread.t3ThreadId } : {}),
    };
  },
});

export const recordTaskIntakeLifecycleReplyPosted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    eventKey: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    externalMessageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: `task-intake.reply.${args.status}`,
      summary: `Task Intake ${args.status} reply was posted.`,
      payloadJson: JSON.stringify({
        status: args.status,
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: Date.now(),
    });

    return null;
  },
});

async function resolveProjectForLinear(ctx: any, teamId: string | undefined) {
  return resolveProjectForTaskIntake(ctx, "linear", teamId);
}

async function resolveProjectForTaskIntake(ctx: any, source: string, teamId: string | undefined) {
  if (teamId !== undefined) {
    const exactRows = await ctx.db
      .query("projects")
      .withIndex("by_linear_team_project", (q: any) =>
        source === "linear"
          ? q.eq("linearTeamId", teamId).eq("linearProjectId", undefined)
          : q.eq("linearTeamId", undefined).eq("linearProjectId", undefined),
      )
      .take(2);
    if (exactRows.length === 1) {
      return exactRows[0];
    }
  }

  const projects = await ctx.db.query("projects").take(2);
  return projects.length === 1 ? projects[0] : null;
}

function taskIntakeEventPayload(args: {
  readonly source: string;
  readonly externalLinkKind: string;
  readonly externalId: string;
  readonly text: string;
  readonly url?: string;
  readonly teamId?: string;
  readonly channelId?: string;
  readonly issueId?: string;
  readonly commentId?: string;
  readonly messageId: string;
  readonly actorDisplayName?: string;
  readonly receivedAt: string;
}) {
  return {
    source: args.source,
    externalLinkKind: args.externalLinkKind,
    externalId: args.externalId,
    messageId: args.messageId,
    receivedAt: args.receivedAt,
    textPreview: args.text.length > 240 ? `${args.text.slice(0, 237)}...` : args.text,
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.teamId !== undefined ? { teamId: args.teamId } : {}),
    ...(args.channelId !== undefined ? { channelId: args.channelId } : {}),
    ...(args.issueId !== undefined ? { issueId: args.issueId } : {}),
    ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
    ...(args.actorDisplayName !== undefined ? { actorDisplayName: args.actorDisplayName } : {}),
  };
}

export const getTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.union(v.null(), taskReturn()),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    return task === null ? null : toTask(task);
  },
});

export const getTaskRuntimeSeed = query({
  args: { taskId: v.id("tasks") },
  returns: v.union(
    v.null(),
    v.object({
      task: v.object({
        id: v.id("tasks"),
        title: v.string(),
        status: taskStatus,
      }),
      project: v.object({
        id: v.id("projects"),
        repoName: v.string(),
        sandboxWorkspaceRoot: v.string(),
        defaultBranch: v.string(),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return null;
    }
    const project = await ctx.db.get(task.projectId);
    if (project === null) {
      return null;
    }

    return {
      task: {
        id: task._id,
        title: task.title,
        status: task.status,
      },
      project: {
        id: project._id,
        repoName: project.repoName,
        sandboxWorkspaceRoot: project.sandboxWorkspaceRoot,
        defaultBranch: project.defaultBranch,
      },
    };
  },
});

export const listTaskTree = query({
  args: {
    includeArchived: v.optional(v.boolean()),
    projectLimit: v.optional(v.number()),
    taskLimitPerProject: v.optional(v.number()),
  },
  returns: taskTreeReturn(),
  handler: async (ctx, args) => {
    const projects = await ctx.db.query("projects").take(args.projectLimit ?? 50);
    const rows = [];

    for (const project of projects) {
      const taskRows = await ctx.db
        .query("tasks")
        .withIndex("by_project_updated", (q: any) => q.eq("projectId", project._id))
        .order("desc")
        .take(args.taskLimitPerProject ?? 100);

      const tasks = [];
      for (const task of taskRows) {
        if (!args.includeArchived && task.archivedAt !== undefined) {
          continue;
        }

        const threadRows = await ctx.db
          .query("taskThreads")
          .withIndex("by_task", (q: any) => q.eq("taskId", task._id))
          .collect();
        const linkRows = await ctx.db
          .query("taskExternalLinks")
          .withIndex("by_task", (q: any) => q.eq("taskId", task._id))
          .collect();

        const threads = threadRows.map(toThreadTreeItem);
        const primaryThread = threads.find(
          (thread) => String(thread.id) === String(task.currentPrimaryTaskThreadId),
        );
        tasks.push({
          id: task._id,
          title: task.title,
          status: task.status,
          ...(task.statusReason !== undefined ? { statusReason: task.statusReason } : {}),
          createdFrom: task.createdFrom,
          updatedAt: task.updatedAt,
          ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
          ...(primaryThread !== undefined ? { primaryThread } : {}),
          threads,
          externalLinks: linkRows.map(toExternalLinkTreeItem),
        });
      }

      rows.push({
        project: {
          id: project._id,
          repoName: project.repoName,
          sandboxWorkspaceRoot: project.sandboxWorkspaceRoot,
          defaultBranch: project.defaultBranch,
          githubOwner: project.githubOwner,
          githubRepo: project.githubRepo,
          ...(project.t3ProjectId !== undefined ? { t3ProjectId: project.t3ProjectId } : {}),
        },
        tasks,
      });
    }

    return rows;
  },
});

function toThreadTreeItem(row: any) {
  return {
    id: row._id,
    t3ThreadId: row.t3ThreadId,
    ...(row.t3ProjectId !== undefined ? { t3ProjectId: row.t3ProjectId } : {}),
    ...(row.branch !== undefined ? { branch: row.branch } : {}),
    ...(row.worktreePath !== undefined ? { worktreePath: row.worktreePath } : {}),
    role: row.role,
    ...(row.codingAgent !== undefined ? { codingAgent: row.codingAgent } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExternalLinkTreeItem(row: any) {
  return {
    id: row._id,
    kind: row.kind,
    externalId: row.externalId,
    ...(row.url !== undefined ? { url: row.url } : {}),
    muted: row.muted,
    ...(row.syncCursor !== undefined ? { syncCursor: row.syncCursor } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
