import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server.js";

const lifecycleReplyStatus = v.union(v.literal("completed"), v.literal("failed"));
const lifecycleReplyLinkKind = v.union(v.literal("linear_issue"), v.literal("slack_thread"));

export interface TaskLifecycleReplyInput {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  readonly workSessionId: string;
  readonly t3ThreadId?: string;
  readonly failureSummary?: string;
}

export function taskLifecycleReplyEventKey(input: {
  readonly workSessionId: string;
  readonly status: "completed" | "failed";
  readonly linkId: string;
}) {
  return `task-lifecycle-reply:${input.workSessionId}:${input.status}:${input.linkId}`;
}

export function buildTaskLifecycleReplyBody(input: TaskLifecycleReplyInput) {
  if (input.status === "completed") {
    return [
      `Task ${input.taskId} completed.`,
      ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
      "Detailed output lives in T3 for this MVP.",
    ].join("\n");
  }

  return [
    `Task ${input.taskId} failed.`,
    ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
    `Failure summary: ${input.failureSummary?.trim() || "Unknown error"}`,
  ].join("\n");
}

function taskEventReturn() {
  return v.object({
    id: v.id("taskEvents"),
    taskId: v.id("tasks"),
    eventKey: v.optional(v.string()),
    kind: v.string(),
    summary: v.string(),
    payloadJson: v.optional(v.string()),
    createdAt: v.number(),
  });
}

function toTaskEvent(row: any) {
  return {
    id: row._id,
    taskId: row.taskId,
    ...(row.eventKey !== undefined ? { eventKey: row.eventKey } : {}),
    kind: row.kind,
    summary: row.summary,
    ...(row.payloadJson !== undefined ? { payloadJson: row.payloadJson } : {}),
    createdAt: row.createdAt,
  };
}

export const appendTaskEvent = internalMutation({
  args: {
    taskId: v.id("tasks"),
    eventKey: v.optional(v.string()),
    kind: v.string(),
    summary: v.string(),
    payloadJson: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  returns: taskEventReturn(),
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      ...(args.eventKey !== undefined ? { eventKey: args.eventKey } : {}),
      kind: args.kind,
      summary: args.summary,
      createdAt: args.createdAt ?? Date.now(),
      ...(args.payloadJson !== undefined ? { payloadJson: args.payloadJson } : {}),
    });
    const event = await ctx.db.get(eventId);
    return toTaskEvent(event);
  },
});

export const claimTaskLifecycleReplies = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    status: lifecycleReplyStatus,
    occurredAt: v.string(),
    t3ThreadId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      linkId: v.id("taskExternalLinks"),
      kind: lifecycleReplyLinkKind,
      externalId: v.string(),
      body: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null) {
      throw new Error(`Work Session ${args.workSessionId} does not exist`);
    }
    if (String(workSession.taskId) !== String(args.taskId)) {
      throw new Error(`Work Session ${args.workSessionId} does not belong to Task ${args.taskId}`);
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const replyBody = buildTaskLifecycleReplyBody({
      taskId: String(args.taskId),
      workSessionId: String(args.workSessionId),
      status: args.status,
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
    });
    const now = Date.now();
    const claimed = [];

    for (const link of links) {
      if (link.muted || (link.kind !== "linear_issue" && link.kind !== "slack_thread")) {
        continue;
      }

      const claimEventKey = taskLifecycleReplyEventKey({
        workSessionId: String(args.workSessionId),
        status: args.status,
        linkId: String(link._id),
      });
      const existingClaim = await ctx.db
        .query("taskEvents")
        .withIndex("by_event_key", (q: any) => q.eq("eventKey", claimEventKey))
        .unique();
      if (existingClaim !== null) {
        continue;
      }

      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: claimEventKey,
        kind: "lifecycle-reply.claimed",
        summary: `Claimed ${args.status} reply for ${link.kind}.`,
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          linkId: link._id,
          kind: link.kind,
          externalId: link.externalId,
          status: args.status,
          occurredAt: args.occurredAt,
          ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: link.kind,
        externalId: link.externalId,
        body: replyBody,
      });
    }

    return claimed;
  },
});

export const recordTaskLifecycleReplyDelivered = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
    status: lifecycleReplyStatus,
    externalMessageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const eventKey = `${args.claimEventKey}:delivered`;
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey,
      kind: "lifecycle-reply.delivered",
      summary: `Delivered ${args.status} lifecycle reply.`,
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: Date.now(),
    });

    return null;
  },
});

export const recordTaskLifecycleReplyFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
    status: lifecycleReplyStatus,
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const eventKey = `${args.claimEventKey}:failed`;
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey,
      kind: "lifecycle-reply.failed",
      summary: `Failed to deliver ${args.status} lifecycle reply.`,
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        error: args.error,
      }),
      createdAt: Date.now(),
    });

    return null;
  },
});

export const listTaskEvents = query({
  args: {
    taskId: v.id("tasks"),
    limit: v.optional(v.number()),
  },
  returns: v.array(taskEventReturn()),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_created", (q: any) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows.map(toTaskEvent);
  },
});
