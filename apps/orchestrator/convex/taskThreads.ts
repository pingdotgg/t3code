import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";

const taskThreadRole = v.union(
  v.literal("primary"),
  v.literal("supporting"),
  v.literal("historical_primary"),
);

function taskThreadReturn() {
  return v.object({
    id: v.id("taskThreads"),
    taskId: v.id("tasks"),
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

function toTaskThread(row: any) {
  return {
    id: row._id,
    taskId: row.taskId,
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

export const attachTaskThread = mutation({
  args: {
    taskId: v.id("tasks"),
    t3ThreadId: v.string(),
    t3ProjectId: v.optional(v.string()),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    role: taskThreadRole,
    codingAgent: v.optional(v.string()),
  },
  returns: taskThreadReturn(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const existing = await ctx.db
      .query("taskThreads")
      .withIndex("by_t3_thread", (q: any) => q.eq("t3ThreadId", args.t3ThreadId))
      .unique();

    const previousPrimaryId = task.currentPrimaryTaskThreadId;
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        role: args.role,
        updatedAt: now,
        ...(args.t3ProjectId !== undefined ? { t3ProjectId: args.t3ProjectId } : {}),
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
        ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
        ...(args.codingAgent !== undefined ? { codingAgent: args.codingAgent } : {}),
      });
      if (args.role === "primary") {
        await markPreviousPrimaryHistorical(ctx, args.taskId, previousPrimaryId, existing._id, now);
        await ctx.db.patch(args.taskId, {
          currentPrimaryTaskThreadId: existing._id,
          updatedAt: now,
        });
      }
      const updated = await ctx.db.get(existing._id);
      return toTaskThread(updated);
    }

    const taskThreadId = await ctx.db.insert("taskThreads", {
      taskId: args.taskId,
      t3ThreadId: args.t3ThreadId,
      role: args.role,
      createdAt: now,
      updatedAt: now,
      ...(args.t3ProjectId !== undefined ? { t3ProjectId: args.t3ProjectId } : {}),
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
      ...(args.codingAgent !== undefined ? { codingAgent: args.codingAgent } : {}),
    });

    if (args.role === "primary") {
      await markPreviousPrimaryHistorical(ctx, args.taskId, previousPrimaryId, taskThreadId, now);
      await ctx.db.patch(args.taskId, {
        currentPrimaryTaskThreadId: taskThreadId,
        updatedAt: now,
      });
    }

    const created = await ctx.db.get(taskThreadId);
    return toTaskThread(created);
  },
});

export const listTaskThreads = query({
  args: { taskId: v.id("tasks") },
  returns: v.array(taskThreadReturn()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("taskThreads")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    return rows.map(toTaskThread);
  },
});

async function markPreviousPrimaryHistorical(
  ctx: any,
  taskId: string,
  previousPrimaryId: string | undefined,
  nextPrimaryId: string,
  now: number,
) {
  if (previousPrimaryId !== undefined && previousPrimaryId !== nextPrimaryId) {
    await ctx.db.patch(previousPrimaryId, {
      role: "historical_primary",
      updatedAt: now,
    });
    await ctx.db.insert("taskEvents", {
      taskId,
      kind: "thread.primary-replaced",
      summary: "Primary thread was replaced.",
      payloadJson: JSON.stringify({
        previousTaskThreadId: previousPrimaryId,
        nextTaskThreadId: nextPrimaryId,
      }),
      createdAt: now,
    });
  }
}
