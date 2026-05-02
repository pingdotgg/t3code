import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";

const workSessionStatus = v.union(
  v.literal("requested"),
  v.literal("accepted"),
  v.literal("started"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("interrupted"),
  v.literal("superseded"),
);

function workSessionReturn() {
  return v.object({
    id: v.id("workSessions"),
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
  });
}

function toWorkSession(row: any) {
  return {
    id: row._id,
    taskId: row.taskId,
    taskThreadId: row.taskThreadId,
    t3ThreadId: row.t3ThreadId,
    status: row.status,
    ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    updatedAt: row.updatedAt,
    ...(row.t3TurnId !== undefined ? { t3TurnId: row.t3TurnId } : {}),
    ...(row.failureSummary !== undefined ? { failureSummary: row.failureSummary } : {}),
    ...(row.bridgeRunId !== undefined ? { bridgeRunId: row.bridgeRunId } : {}),
  };
}

export const createWorkSession = mutation({
  args: {
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    t3ThreadId: v.string(),
    status: v.optional(workSessionStatus),
    bridgeRunId: v.optional(v.string()),
  },
  returns: workSessionReturn(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }
    const thread = await ctx.db.get(args.taskThreadId);
    if (thread === null || String(thread.taskId) !== String(args.taskId)) {
      throw new Error(`Task thread ${args.taskThreadId} does not belong to Task ${args.taskId}`);
    }

    const now = Date.now();
    const workSessionId = await ctx.db.insert("workSessions", {
      taskId: args.taskId,
      taskThreadId: args.taskThreadId,
      t3ThreadId: args.t3ThreadId,
      status: args.status ?? "requested",
      updatedAt: now,
      ...(args.bridgeRunId !== undefined ? { bridgeRunId: args.bridgeRunId } : {}),
    });

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      kind: "work-session.requested",
      summary: "Coding Agent work session was requested.",
      payloadJson: JSON.stringify({ workSessionId, t3ThreadId: args.t3ThreadId }),
      createdAt: now,
    });

    const workSession = await ctx.db.get(workSessionId);
    return toWorkSession(workSession);
  },
});

export const updateWorkSessionStatus = mutation({
  args: {
    workSessionId: v.id("workSessions"),
    status: workSessionStatus,
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
  },
  returns: workSessionReturn(),
  handler: async (ctx, args) => {
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null) {
      throw new Error(`Work Session ${args.workSessionId} does not exist`);
    }

    const now = Date.now();
    const shouldSetStartedAt = args.status === "started" && workSession.startedAt === undefined;
    const shouldSetEndedAt =
      args.status === "completed" ||
      args.status === "failed" ||
      args.status === "interrupted" ||
      args.status === "superseded";

    await ctx.db.patch(args.workSessionId, {
      status: args.status,
      updatedAt: now,
      ...(shouldSetStartedAt ? { startedAt: now } : {}),
      ...(shouldSetEndedAt ? { endedAt: now } : {}),
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
    });

    if (workSession.status !== args.status) {
      await ctx.db.insert("taskEvents", {
        taskId: workSession.taskId,
        kind: `work-session.${args.status}`,
        summary: `Work Session moved from ${workSession.status} to ${args.status}.`,
        payloadJson: JSON.stringify({
          workSessionId: args.workSessionId,
          from: workSession.status,
          to: args.status,
          ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
          ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
        }),
        createdAt: now,
      });
    }

    const updated = await ctx.db.get(args.workSessionId);
    return toWorkSession(updated);
  },
});

export const listWorkSessionsForTask = query({
  args: {
    taskId: v.id("tasks"),
    limit: v.optional(v.number()),
  },
  returns: v.array(workSessionReturn()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workSessions")
      .withIndex("by_task_updated", (q: any) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(args.limit ?? 20);
    return rows.map(toWorkSession);
  },
});

export const getWorkSessionByBridgeRunId = query({
  args: { bridgeRunId: v.string() },
  returns: v.union(v.null(), workSessionReturn()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("workSessions")
      .withIndex("by_bridge_run", (q: any) => q.eq("bridgeRunId", args.bridgeRunId))
      .unique();
    return row === null ? null : toWorkSession(row);
  },
});
