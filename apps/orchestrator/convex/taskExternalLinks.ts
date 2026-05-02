import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";

const linkKind = v.union(
  v.literal("linear_issue"),
  v.literal("slack_thread"),
  v.literal("support_email_thread"),
  v.literal("webhook_event"),
  v.literal("github_pr"),
);

function linkReturn() {
  return v.object({
    id: v.id("taskExternalLinks"),
    taskId: v.id("tasks"),
    kind: linkKind,
    externalId: v.string(),
    url: v.optional(v.string()),
    muted: v.boolean(),
    syncCursor: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  });
}

function toLink(row: any) {
  return {
    id: row._id,
    taskId: row.taskId,
    kind: row.kind,
    externalId: row.externalId,
    ...(row.url !== undefined ? { url: row.url } : {}),
    muted: row.muted,
    ...(row.syncCursor !== undefined ? { syncCursor: row.syncCursor } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const upsertTaskExternalLink = mutation({
  args: {
    taskId: v.id("tasks"),
    kind: linkKind,
    externalId: v.string(),
    url: v.optional(v.string()),
    muted: v.optional(v.boolean()),
    syncCursor: v.optional(v.string()),
  },
  returns: linkReturn(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", args.kind).eq("externalId", args.externalId),
      )
      .unique();

    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        taskId: args.taskId,
        muted: args.muted ?? existing.muted,
        updatedAt: now,
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.syncCursor !== undefined ? { syncCursor: args.syncCursor } : {}),
      });
      const updated = await ctx.db.get(existing._id);
      return toLink(updated);
    }

    const linkId = await ctx.db.insert("taskExternalLinks", {
      taskId: args.taskId,
      kind: args.kind,
      externalId: args.externalId,
      muted: args.muted ?? false,
      createdAt: now,
      updatedAt: now,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.syncCursor !== undefined ? { syncCursor: args.syncCursor } : {}),
    });
    const created = await ctx.db.get(linkId);
    return toLink(created);
  },
});

export const setTaskExternalLinkMuted = mutation({
  args: {
    kind: linkKind,
    externalId: v.string(),
    muted: v.boolean(),
  },
  returns: v.union(v.null(), linkReturn()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", args.kind).eq("externalId", args.externalId),
      )
      .unique();
    if (row === null) {
      return null;
    }

    await ctx.db.patch(row._id, {
      muted: args.muted,
      updatedAt: Date.now(),
    });
    const updated = await ctx.db.get(row._id);
    return toLink(updated);
  },
});

export const listTaskExternalLinks = query({
  args: { taskId: v.id("tasks") },
  returns: v.array(linkReturn()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    return rows.map(toLink);
  },
});

export const findTaskExternalLink = query({
  args: {
    kind: linkKind,
    externalId: v.string(),
  },
  returns: v.union(v.null(), linkReturn()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", args.kind).eq("externalId", args.externalId),
      )
      .unique();
    return row === null ? null : toLink(row);
  },
});
