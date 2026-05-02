import { v } from "convex/values";

import { createT3ExecutionBridgeClient } from "../src/t3/client.ts";
import { internal, api } from "./_generated/api.js";
import { action, internalMutation } from "./_generated/server.js";

export const materializeTaskRuntime = action({
  args: {
    taskId: v.id("tasks"),
    initialPrompt: v.string(),
    startCodingAgent: v.optional(v.boolean()),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    branch: v.union(v.null(), v.string()),
    worktreePath: v.union(v.null(), v.string()),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const tree = await ctx.runQuery(api.tasks.getTaskRuntimeSeed, {
      taskId: args.taskId,
    });
    if (tree === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const workSessionSeed = await ctx.runMutation(internal.t3Runtime.prepareWorkSessionSeed, {
      taskId: args.taskId,
      startCodingAgent: args.startCodingAgent ?? true,
    });

    const client = createT3ExecutionBridgeClient();
    const response = await client.materializeTaskRuntime({
      taskId: String(args.taskId),
      workSessionId: String(workSessionSeed.workSessionId),
      initialPrompt: args.initialPrompt,
      title: tree.task.title,
      runtimeMode: "full-access",
      interactionMode: "default",
      startCodingAgent: args.startCodingAgent ?? true,
      project: {
        repoName: tree.project.repoName,
        workspaceRoot: tree.project.sandboxWorkspaceRoot,
        defaultBranch: tree.project.defaultBranch,
      },
    });

    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeMaterialized, {
      taskId: args.taskId,
      taskThreadId: workSessionSeed.taskThreadId,
      workSessionId: workSessionSeed.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
      acceptedAt: Date.parse(response.acceptedAt),
      ...(response.branch !== null ? { branch: response.branch } : {}),
      ...(response.worktreePath !== null ? { worktreePath: response.worktreePath } : {}),
    });

    return {
      taskId: response.taskId,
      workSessionId: response.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
      branch: response.branch ?? null,
      worktreePath: response.worktreePath ?? null,
      acceptedAt: response.acceptedAt,
    };
  },
});

export const prepareWorkSessionSeed = internalMutation({
  args: { taskId: v.id("tasks"), startCodingAgent: v.boolean() },
  returns: v.object({
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
  }),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const now = Date.now();
    const taskThreadId = await ctx.db.insert("taskThreads", {
      taskId: args.taskId,
      t3ThreadId: `pending:${crypto.randomUUID()}`,
      role: "primary",
      createdAt: now,
      updatedAt: now,
    });

    const workSessionId = await ctx.db.insert("workSessions", {
      taskId: args.taskId,
      taskThreadId,
      t3ThreadId: `pending:${String(taskThreadId)}`,
      status: "requested",
      updatedAt: now,
      bridgeRunId: String(taskThreadId),
    });

    await ctx.db.patch(args.taskId, {
      currentPrimaryTaskThreadId: taskThreadId,
      status:
        task.status === "ready" ? (args.startCodingAgent ? "working" : "needs_input") : task.status,
      updatedAt: now,
    });

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      kind: "runtime.materialization-requested",
      summary: "T3 runtime materialization was requested.",
      payloadJson: JSON.stringify({ taskThreadId, workSessionId }),
      createdAt: now,
    });

    return { taskThreadId, workSessionId };
  },
});

export const recordTaskRuntimeMaterialized = internalMutation({
  args: {
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    acceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskThreadId, {
      t3ProjectId: args.t3ProjectId,
      t3ThreadId: args.t3ThreadId,
      updatedAt: args.acceptedAt,
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
    });

    await ctx.db.patch(args.workSessionId, {
      t3ThreadId: args.t3ThreadId,
      status: "accepted",
      updatedAt: args.acceptedAt,
    });

    const task = await ctx.db.get(args.taskId);
    if (task !== null) {
      await ctx.db.patch(args.taskId, {
        currentPrimaryTaskThreadId: args.taskThreadId,
        updatedAt: args.acceptedAt,
      });
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      kind: "runtime.materialized",
      summary: "T3 runtime was materialized for the Task.",
      payloadJson: JSON.stringify({
        taskThreadId: args.taskThreadId,
        workSessionId: args.workSessionId,
        t3ProjectId: args.t3ProjectId,
        t3ThreadId: args.t3ThreadId,
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
        ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
      }),
      createdAt: args.acceptedAt,
    });

    return null;
  },
});

export const applyTaskRuntimeLifecycleEvent = internalMutation({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    type: v.union(
      v.literal("started"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("interrupted"),
    ),
    occurredAt: v.string(),
    t3ThreadId: v.optional(v.string()),
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
  },
  returns: v.object({
    applied: v.boolean(),
    status: v.union(
      v.literal("requested"),
      v.literal("accepted"),
      v.literal("started"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("interrupted"),
      v.literal("superseded"),
    ),
  }),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventId))
      .unique();
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null) {
      throw new Error(`Work Session ${args.workSessionId} does not exist`);
    }
    if (String(workSession.taskId) !== String(args.taskId)) {
      throw new Error(`Work Session ${args.workSessionId} does not belong to Task ${args.taskId}`);
    }
    if (existingEvent !== null) {
      return { applied: false, status: workSession.status };
    }

    const occurredAtMs = Date.parse(args.occurredAt);
    const nextStatus = args.type;
    const ended =
      args.type === "completed" || args.type === "failed" || args.type === "interrupted";

    await ctx.db.patch(args.workSessionId, {
      status: nextStatus,
      updatedAt: occurredAtMs,
      ...(args.type === "started" && workSession.startedAt === undefined
        ? { startedAt: occurredAtMs }
        : {}),
      ...(ended ? { endedAt: occurredAtMs } : {}),
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
    });

    if (args.type === "failed") {
      await ctx.db.patch(args.taskId, {
        status: "failed",
        statusReason: args.failureSummary ?? "Coding Agent work failed.",
        updatedAt: occurredAtMs,
      });
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventId,
      kind: `work-session.${args.type}`,
      summary: `Work Session ${args.type}.`,
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
        ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
        ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
      }),
      createdAt: occurredAtMs,
    });

    return { applied: true, status: nextStatus };
  },
});
