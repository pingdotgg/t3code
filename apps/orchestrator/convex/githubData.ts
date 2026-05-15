import { v } from "convex/values";
import * as DateTime from "effect/DateTime";

import { internalMutation, internalQuery } from "./_generated/server.js";

export const findPullRequestsByHeadSha = internalQuery({
  args: {
    owner: v.string(),
    repo: v.string(),
    headSha: v.string(),
  },
  returns: v.array(
    v.object({
      id: v.id("githubPullRequests"),
      taskId: v.id("tasks"),
      externalId: v.string(),
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
      url: v.string(),
      headBranch: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("githubPullRequests")
      .withIndex("by_repo_head_sha", (q: any) =>
        q.eq("owner", args.owner).eq("repo", args.repo).eq("headSha", args.headSha),
      )
      .collect();

    return rows.map((row) => {
      const result: {
        id: typeof row._id;
        taskId: typeof row.taskId;
        externalId: string;
        owner: string;
        repo: string;
        number: number;
        url: string;
        headBranch?: string;
      } = {
        id: row._id,
        taskId: row.taskId,
        externalId: row.externalId,
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        url: row.url,
      };
      if (row.headBranch !== undefined) {
        result.headBranch = row.headBranch;
      }
      return result;
    });
  },
});

export const findPullRequestByExternalId = internalQuery({
  args: {
    externalId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("githubPullRequests"),
      taskId: v.id("tasks"),
      externalId: v.string(),
      owner: v.string(),
      repo: v.string(),
      number: v.number(),
      url: v.string(),
      headBranch: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("githubPullRequests")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", args.externalId))
      .unique();
    if (row === null) {
      return null;
    }

    return {
      id: row._id,
      taskId: row.taskId,
      externalId: row.externalId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      url: row.url,
      ...(row.headBranch !== undefined ? { headBranch: row.headBranch } : {}),
      ...(row.title !== undefined ? { title: row.title } : {}),
    };
  },
});

export const hasMergedPullRequestForTask = internalQuery({
  args: {
    taskId: v.id("tasks"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("githubPullRequests")
      .filter((q) => q.eq(q.field("taskId"), args.taskId))
      .collect();
    return rows.some((row) => row.state === "merged" || row.mergedAt !== undefined);
  },
});

export const recordPullRequestMerged = internalMutation({
  args: {
    externalId: v.string(),
    mergedAt: v.optional(v.number()),
    title: v.optional(v.string()),
    headSha: v.optional(v.string()),
    headBranch: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("githubPullRequests")
      .withIndex("by_external_id", (q: any) => q.eq("externalId", args.externalId))
      .unique();
    if (row === null) {
      return null;
    }

    await ctx.db.patch(row._id, {
      state: "merged",
      mergedAt: args.mergedAt ?? DateTime.toEpochMillis(DateTime.nowUnsafe()),
      updatedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.headSha !== undefined ? { headSha: args.headSha } : {}),
      ...(args.headBranch !== undefined ? { headBranch: args.headBranch } : {}),
    });

    const task = await ctx.db.get(row.taskId);
    if (task !== null && task.status !== "done") {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      await ctx.db.patch(row.taskId, {
        status: "done",
        statusReason: `Pull request merged: ${row.url}`,
        archivedAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("taskEvents", {
        taskId: row.taskId,
        eventKey: `${args.externalId}:task-done`,
        kind: "status.changed",
        summary: `Task status changed from ${task.status} to done.`,
        payloadJson: JSON.stringify({
          from: task.status,
          to: "done",
          reason: `Pull request merged: ${row.url}`,
        }),
        createdAt: now,
      });
    }

    return null;
  },
});
