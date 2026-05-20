import { v } from "convex/values";
import * as DateTime from "effect/DateTime";

import { mutation } from "./_generated/server.js";

export const adoptSlackTaskRuntime = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    slackExternalId: v.string(),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    worktreePath: v.optional(v.string()),
    branch: v.optional(v.string()),
    environmentId: v.optional(v.string()),
    runtimeEndpointUrl: v.optional(v.string()),
    t3TurnId: v.optional(v.string()),
  },
  returns: v.object({
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
    existing: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existingLink = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", "slack_thread").eq("externalId", args.slackExternalId),
      )
      .unique();
    if (existingLink !== null) {
      const task = await ctx.db.get(existingLink.taskId);
      if (task === null) {
        throw new Error(`Linked Task ${existingLink.taskId} does not exist`);
      }
      const taskThread =
        task.currentPrimaryTaskThreadId === undefined
          ? null
          : await ctx.db.get(task.currentPrimaryTaskThreadId);
      const workSession = (
        await ctx.db
          .query("workSessions")
          .withIndex("by_task_updated", (q: any) => q.eq("taskId", task._id))
          .order("desc")
          .take(1)
      )[0];
      if (taskThread === null || workSession === undefined) {
        throw new Error(`Existing Task ${task._id} is missing runtime state`);
      }
      return {
        taskId: task._id,
        taskThreadId: taskThread._id,
        workSessionId: workSession._id,
        existing: true,
      };
    }

    const project = await ctx.db.get(args.projectId);
    if (project === null) {
      throw new Error(`Project ${args.projectId} does not exist`);
    }

    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const taskId = await ctx.db.insert("tasks", {
      projectId: args.projectId,
      title: args.title,
      status: "working",
      createdFrom: "slack",
      createdAt: now,
      updatedAt: now,
    });
    const taskThreadId = await ctx.db.insert("taskThreads", {
      taskId,
      role: "primary",
      t3ProjectId: args.t3ProjectId,
      t3ThreadId: args.t3ThreadId,
      createdAt: now,
      updatedAt: now,
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
    });
    const workSessionId = await ctx.db.insert("workSessions", {
      taskId,
      taskThreadId,
      t3ThreadId: args.t3ThreadId,
      status: "completed",
      bridgeRunId: String(taskThreadId),
      runtimeStatus: "requested",
      runtimeUpdatedAt: now,
      startedAt: now,
      endedAt: now,
      updatedAt: now,
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
      ...(args.runtimeEndpointUrl !== undefined
        ? { runtimeEndpointUrl: args.runtimeEndpointUrl }
        : {}),
    });
    await ctx.db.patch(taskId, {
      currentPrimaryTaskThreadId: taskThreadId,
      updatedAt: now,
    });
    await ctx.db.insert("taskExternalLinks", {
      taskId,
      kind: "slack_thread",
      externalId: args.slackExternalId,
      muted: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("taskEvents", {
      taskId,
      kind: "task.adopted-from-dev",
      summary: "Task runtime was adopted into production from the previous dev deployment.",
      payloadJson: JSON.stringify({
        taskThreadId,
        workSessionId,
        slackExternalId: args.slackExternalId,
        t3ThreadId: args.t3ThreadId,
        t3ProjectId: args.t3ProjectId,
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
        ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
        ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
      }),
      createdAt: now,
    });

    return { taskId, taskThreadId, workSessionId, existing: false };
  },
});
