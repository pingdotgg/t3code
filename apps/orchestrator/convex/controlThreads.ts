import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";

const linearIngressArgs = {
  eventId: v.string(),
  linearThreadKey: v.string(),
  issueId: v.string(),
  commentId: v.optional(v.string()),
  messageId: v.optional(v.string()),
  teamId: v.optional(v.string()),
  threadKind: v.union(v.literal("issue"), v.literal("comment")),
  title: v.optional(v.string()),
  summary: v.optional(v.string()),
  authorName: v.optional(v.string()),
  body: v.string(),
  bodyPreview: v.optional(v.string()),
  commentUrl: v.optional(v.string()),
  receivedAt: v.number(),
  shouldStartRun: v.boolean(),
} as const;

export const upsertFromLinearIngress = internalMutation({
  args: linearIngressArgs,
  returns: v.object({
    controlThreadId: v.id("controlThreads"),
    threadKey: v.string(),
    createdThread: v.boolean(),
    eventApplied: v.boolean(),
    shouldStartRun: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existingEvent = await ctx.db
      .query("controlThreadEvents")
      .withIndex("by_event_key", (query: any) => query.eq("eventKey", args.eventId))
      .unique();

    if (existingEvent !== null) {
      const controlThread = await ctx.db.get(existingEvent.controlThreadId);
      return {
        controlThreadId: controlThread?._id ?? existingEvent.controlThreadId,
        threadKey: controlThread?.linearThreadKey ?? args.linearThreadKey,
        createdThread: false,
        eventApplied: false,
        shouldStartRun: args.shouldStartRun,
      };
    }

    const existingThread = await ctx.db
      .query("controlThreads")
      .withIndex("by_linear_thread_key", (query: any) =>
        query.eq("linearThreadKey", args.linearThreadKey),
      )
      .unique();

    const nextThread =
      existingThread === null
        ? await ctx.db.insert("controlThreads", {
            source: "linear",
            linearThreadKey: args.linearThreadKey,
            linearThreadKind: args.threadKind,
            linearIssueId: args.issueId,
            state: "open",
            lastEventId: args.eventId,
            lastIngressAt: args.receivedAt,
            createdAt: now,
            updatedAt: now,
            ...(args.commentId !== undefined ? { linearCommentId: args.commentId } : {}),
            ...(args.teamId !== undefined ? { linearTeamId: args.teamId } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.summary !== undefined || args.bodyPreview !== undefined
              ? { summary: args.summary ?? args.bodyPreview }
              : {}),
          })
        : (await ctx.db.patch(existingThread._id, {
            linearThreadKind: args.threadKind,
            linearIssueId: args.issueId,
            lastEventId: args.eventId,
            lastIngressAt: args.receivedAt,
            updatedAt: now,
            ...(args.commentId !== undefined ? { linearCommentId: args.commentId } : {}),
            ...(args.teamId !== undefined ? { linearTeamId: args.teamId } : {}),
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.summary !== undefined || args.bodyPreview !== undefined
              ? { summary: args.summary ?? args.bodyPreview }
              : {}),
          }),
          existingThread._id);

    await ctx.db.insert("controlThreadEvents", {
      controlThreadId: nextThread,
      eventKey: args.eventId,
      kind: "linear.ingress",
      payloadJson: JSON.stringify(args),
      createdAt: now,
    });

    const existingMessage = await ctx.db
      .query("controlThreadMessages")
      .withIndex("by_external_message_key", (query: any) =>
        query.eq("externalMessageKey", args.messageId ?? args.eventId),
      )
      .unique();

    if (existingMessage === null) {
      await ctx.db.insert("controlThreadMessages", {
        controlThreadId: nextThread,
        externalMessageKey: args.messageId ?? args.eventId,
        createdAt: now,
        updatedAt: now,
        ...(args.authorName !== undefined ? { authorName: args.authorName } : {}),
        ...(args.bodyPreview !== undefined ? { bodyPreview: args.bodyPreview } : {}),
      });
    } else {
      await ctx.db.patch(existingMessage._id, {
        updatedAt: now,
        ...(args.authorName !== undefined ? { authorName: args.authorName } : {}),
        ...(args.bodyPreview !== undefined ? { bodyPreview: args.bodyPreview } : {}),
      });
    }

    return {
      controlThreadId: nextThread,
      threadKey: args.linearThreadKey,
      createdThread: existingThread === null,
      eventApplied: true,
      shouldStartRun: args.shouldStartRun,
    };
  },
});

export const getControlThread = internalQuery({
  args: {
    controlThreadId: v.id("controlThreads"),
  },
  returns: v.union(
    v.null(),
    v.object({
      id: v.id("controlThreads"),
      threadKey: v.string(),
      issueId: v.string(),
      commentId: v.optional(v.string()),
      state: v.union(
        v.literal("open"),
        v.literal("active"),
        v.literal("waiting"),
        v.literal("closed"),
      ),
      title: v.optional(v.string()),
      summary: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.controlThreadId);
    if (row === null) {
      return null;
    }

    return {
      id: row._id,
      threadKey: row.linearThreadKey,
      issueId: row.linearIssueId,
      ...(row.linearCommentId !== undefined ? { commentId: row.linearCommentId } : {}),
      state: row.state,
      ...(row.title !== undefined ? { title: row.title } : {}),
      ...(row.summary !== undefined ? { summary: row.summary } : {}),
    };
  },
});

export const listControlThreads = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      id: v.id("controlThreads"),
      threadKey: v.string(),
      threadKind: v.union(v.literal("issue"), v.literal("comment")),
      state: v.union(
        v.literal("open"),
        v.literal("active"),
        v.literal("waiting"),
        v.literal("closed"),
      ),
      lastEventId: v.string(),
      title: v.optional(v.string()),
      summary: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const rows: any[] = await ctx.db.query("controlThreads").order("desc").take(limit);
    return rows.map((row: any) => ({
      id: row._id,
      threadKey: row.linearThreadKey,
      threadKind: row.linearThreadKind,
      state: row.state,
      lastEventId: row.lastEventId,
      title: row.title,
      summary: row.summary,
      updatedAt: row.updatedAt,
    }));
  },
});
