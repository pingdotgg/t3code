import { v } from "convex/values";
import * as DateTime from "effect/DateTime";

import { internalMutation, internalQuery, query } from "./_generated/server.js";

const lifecycleReplyStatus = v.union(v.literal("completed"), v.literal("failed"));
const lifecycleReplyLinkKind = v.union(v.literal("linear_issue"), v.literal("slack_thread"));
const mutedExplicitReplyWindowMs = 2 * 60 * 60 * 1000;
type LifecycleReplyLinkKind = "linear_issue" | "slack_thread";

export interface TaskLifecycleReplyInput {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  readonly workSessionId: string;
  readonly t3ThreadId?: string;
  readonly failureSummary?: string;
  readonly pullRequestUrl?: string;
  readonly assistantResponse?: string;
}

export function taskLifecycleReplyEventKey(input: {
  readonly workSessionId: string;
  readonly status: "completed" | "failed";
  readonly linkId: string;
  readonly t3TurnId?: string;
}) {
  if (input.t3TurnId !== undefined) {
    return `task-lifecycle-reply:${input.workSessionId}:${input.t3TurnId}:${input.status}:${input.linkId}`;
  }
  return `task-lifecycle-reply:${input.workSessionId}:${input.status}:${input.linkId}`;
}

export function taskAssistantMessageReplyEventKey(input: {
  readonly workSessionId: string;
  readonly t3MessageId: string;
  readonly linkId: string;
}) {
  return `task-assistant-message-reply:${input.workSessionId}:${input.t3MessageId}:${input.linkId}`;
}

export function taskUserInputRequestEventKey(input: {
  readonly workSessionId: string;
  readonly requestId: string;
}) {
  return `task-user-input-request:${input.workSessionId}:${input.requestId}`;
}

export function taskUserInputRequestReplyEventKey(input: {
  readonly workSessionId: string;
  readonly requestId: string;
  readonly linkId: string;
}) {
  return `task-user-input-request-reply:${input.workSessionId}:${input.requestId}:${input.linkId}`;
}

export function taskUserInputAnswerEventKey(input: {
  readonly workSessionId: string;
  readonly requestId: string;
  readonly sourceEventId: string;
}) {
  return `task-user-input-answer:${input.workSessionId}:${input.requestId}:${input.sourceEventId}`;
}

export function taskPullRequestStatusReplyEventKey(input: {
  readonly pullRequestExternalId: string;
  readonly linkId: string;
}) {
  return `task-pr-status-reply:${input.pullRequestExternalId}:${input.linkId}`;
}

export function taskStartedStatusReplyEventKey(input: {
  readonly taskId: string;
  readonly linkId: string;
}) {
  return `task-started-status-reply:${input.taskId}:${input.linkId}`;
}

export function githubDeploymentReadyReplyEventKey(input: {
  readonly taskId: string;
  readonly deploymentId: string;
  readonly url: string;
  readonly linkId: string;
}) {
  return `github-deployment-ready:${input.taskId}:${input.deploymentId}:${input.url}:${input.linkId}`;
}

export function githubPullRequestMergedNotificationEventKey(input: {
  readonly taskId: string;
  readonly pullRequestExternalId: string;
  readonly linkId: string;
}) {
  return `github-pr-merged:${input.taskId}:${input.pullRequestExternalId}:${input.linkId}`;
}

export function buildTaskUserInputRequestReplyBody(input: {
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options?: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
    }>;
    readonly multiSelect?: boolean;
  }>;
}) {
  const lines: string[] = [];
  for (const question of input.questions) {
    if (lines.length > 0) {
      lines.push("");
    }
    const header = question.header.trim();
    if (header) {
      lines.push(`*${header}*`);
    }
    lines.push(question.question);
    const options = question.options ?? [];
    if (options.length > 0) {
      for (const option of options) {
        lines.push(`- ${option.label}: ${option.description}`);
      }
    }
    if (question.multiSelect === true) {
      lines.push("_You can answer with one or more options._");
    }
  }
  return lines.join("\n");
}

export function buildTaskPullRequestStatusReplyBody(input: {
  readonly pullRequestUrl: string;
  readonly previewUrl?: string;
  readonly deploymentPreviews?: ReadonlyArray<{
    readonly environment?: string;
    readonly url: string;
  }>;
}) {
  const previewLines =
    input.deploymentPreviews !== undefined && input.deploymentPreviews.length > 0
      ? input.deploymentPreviews.map((preview) =>
          preview.environment !== undefined
            ? `Preview (${preview.environment}): ${preview.url}`
            : `Preview: ${preview.url}`,
        )
      : input.previewUrl !== undefined
        ? [`Preview: ${input.previewUrl}`]
        : [];

  return [`Pull request: ${input.pullRequestUrl}`, ...previewLines].join("\n");
}

export function buildTaskLifecycleReplyBody(input: TaskLifecycleReplyInput) {
  if (input.status === "completed") {
    const assistantResponse = input.assistantResponse?.trim();
    if (assistantResponse) {
      return assistantResponse;
    }

    return [
      `Task ${input.taskId} completed.`,
      ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
      ...(input.pullRequestUrl !== undefined ? [`Pull request: ${input.pullRequestUrl}`] : []),
      "Detailed output lives in T3 for this MVP.",
    ].join("\n");
  }

  return [
    `Task ${input.taskId} failed.`,
    ...(input.t3ThreadId !== undefined ? [`Primary T3 thread: \`${input.t3ThreadId}\``] : []),
    ...(input.pullRequestUrl !== undefined ? [`Pull request: ${input.pullRequestUrl}`] : []),
    `Failure summary: ${input.failureSummary?.trim() || "Unknown error"}`,
  ].join("\n");
}

function hasDeliveredAssistantMessageReply(input: {
  readonly taskEvents: Array<{
    readonly kind: string;
    readonly payloadJson?: string;
  }>;
  readonly workSessionId: string;
  readonly linkId: string;
}) {
  return input.taskEvents.some((event) => {
    if (event.kind !== "assistant-message-reply.delivered" || event.payloadJson === undefined) {
      return false;
    }

    try {
      const payload = JSON.parse(event.payloadJson) as {
        readonly workSessionId?: unknown;
        readonly linkId?: unknown;
      };
      return (
        String(payload.workSessionId) === input.workSessionId &&
        String(payload.linkId) === input.linkId
      );
    } catch {
      return false;
    }
  });
}

function payloadJsonTextPreview(payloadJson: string | undefined) {
  if (payloadJson === undefined) {
    return undefined;
  }
  try {
    const payload = JSON.parse(payloadJson) as { readonly textPreview?: unknown };
    return typeof payload.textPreview === "string" ? payload.textPreview : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitVevinInvocation(payloadJson: string | undefined) {
  const textPreview = payloadJsonTextPreview(payloadJson)?.toLowerCase();
  if (textPreview === undefined) {
    return false;
  }

  const botUserId = process.env.SLACK_BOT_USER_ID?.trim();
  const botUserName = process.env.SLACK_BOT_USERNAME?.trim().toLowerCase() || "vevin";
  return (
    (botUserId !== undefined &&
      botUserId.length > 0 &&
      textPreview.includes(`<@${botUserId.toLowerCase()}`)) ||
    textPreview.includes(`@${botUserName}`)
  );
}

function isPullRequestStatusReplyForLink(input: {
  readonly event: { readonly kind: string; readonly payloadJson?: string };
  readonly pullRequestExternalId: string;
  readonly linkId: string;
}) {
  if (input.event.kind !== "pr-status-reply.claimed" || input.event.payloadJson === undefined) {
    return false;
  }

  try {
    const payload = JSON.parse(input.event.payloadJson) as {
      readonly pullRequestExternalId?: unknown;
      readonly linkId?: unknown;
    };
    return (
      String(payload.pullRequestExternalId) === input.pullRequestExternalId &&
      String(payload.linkId) === input.linkId
    );
  } catch {
    return false;
  }
}

async function canDeliverToExternalLink(
  ctx: any,
  input: {
    readonly taskId: any;
    readonly link: { readonly kind: string; readonly muted?: boolean };
    readonly now: number;
  },
) {
  if (input.link.kind !== "linear_issue" && input.link.kind !== "slack_thread") {
    return false;
  }
  if (input.link.muted !== true) {
    return true;
  }
  if (input.link.kind !== "slack_thread") {
    return false;
  }

  const recentEvents = await ctx.db
    .query("taskEvents")
    .withIndex("by_task_created", (q: any) => q.eq("taskId", input.taskId))
    .order("desc")
    .take(100);

  for (const event of recentEvents) {
    if (input.now - event.createdAt > mutedExplicitReplyWindowMs) {
      continue;
    }
    if (event.kind === "user-input.resolved") {
      return true;
    }
    if (event.kind === "task-intake.follow-up" && isExplicitVevinInvocation(event.payloadJson)) {
      return true;
    }
  }

  return false;
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
      createdAt: args.createdAt ?? DateTime.toEpochMillis(DateTime.nowUnsafe()),
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
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
    assistantResponse: v.optional(v.string()),
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
    const pullRequestLink = links.find((candidate) => candidate.kind === "github_pr");
    const taskEvents =
      args.status === "completed"
        ? await ctx.db
            .query("taskEvents")
            .withIndex("by_task_created", (q: any) => q.eq("taskId", args.taskId))
            .collect()
        : [];
    const replyBody = buildTaskLifecycleReplyBody({
      taskId: String(args.taskId),
      workSessionId: String(args.workSessionId),
      status: args.status,
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
      ...(pullRequestLink?.url !== undefined ? { pullRequestUrl: pullRequestLink.url } : {}),
      ...(args.assistantResponse !== undefined
        ? { assistantResponse: args.assistantResponse }
        : workSession.assistantResponse !== undefined
          ? { assistantResponse: workSession.assistantResponse }
          : {}),
    });
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];

    for (const link of links) {
      if (!(await canDeliverToExternalLink(ctx, { taskId: args.taskId, link, now }))) {
        continue;
      }
      const linkKind: LifecycleReplyLinkKind =
        link.kind === "linear_issue" ? "linear_issue" : "slack_thread";
      if (
        args.status === "completed" &&
        hasDeliveredAssistantMessageReply({
          taskEvents,
          workSessionId: String(args.workSessionId),
          linkId: String(link._id),
        })
      ) {
        continue;
      }

      const claimEventKey = taskLifecycleReplyEventKey({
        workSessionId: String(args.workSessionId),
        status: args.status,
        linkId: String(link._id),
        ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
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
        summary: `Claimed ${args.status} reply for ${linkKind}.`,
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          linkId: link._id,
          kind: linkKind,
          externalId: link.externalId,
          status: args.status,
          occurredAt: args.occurredAt,
          ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
          ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: linkKind,
        externalId: link.externalId,
        body: replyBody,
      });
    }

    return claimed;
  },
});

export const claimTaskPullRequestStatusReplies = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    pullRequestExternalId: v.string(),
    pullRequestUrl: v.string(),
    pullRequestStatus: v.optional(v.union(v.literal("created"), v.literal("existing"))),
    title: v.optional(v.string()),
    repo: v.optional(v.string()),
    headBranch: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    deploymentPreviewsJson: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      linkId: v.id("taskExternalLinks"),
      kind: lifecycleReplyLinkKind,
      externalId: v.string(),
      body: v.string(),
      pullRequestUrl: v.string(),
      pullRequestStatus: v.optional(v.union(v.literal("created"), v.literal("existing"))),
      title: v.optional(v.string()),
      repo: v.optional(v.string()),
      branch: v.optional(v.string()),
      t3ThreadId: v.optional(v.string()),
      environmentId: v.optional(v.string()),
      previewUrl: v.optional(v.string()),
      deploymentPreviews: v.optional(
        v.array(
          v.object({
            provider: v.optional(v.string()),
            environment: v.optional(v.string()),
            url: v.string(),
          }),
        ),
      ),
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
    const taskThread = await ctx.db.get(workSession.taskThreadId);
    if (taskThread === null) {
      throw new Error(`Task Thread ${workSession.taskThreadId} does not exist`);
    }
    const project = await ctx.db.get(task.projectId);
    if (project === null) {
      throw new Error(`Project ${task.projectId} does not exist`);
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const deploymentPreviews =
      args.deploymentPreviewsJson !== undefined
        ? (JSON.parse(args.deploymentPreviewsJson) as Array<{
            readonly provider?: string;
            readonly environment?: string;
            readonly url: string;
          }>)
        : undefined;
    const body = buildTaskPullRequestStatusReplyBody({
      pullRequestUrl: args.pullRequestUrl,
      ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
      ...(deploymentPreviews !== undefined ? { deploymentPreviews } : {}),
    });
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];
    const previousEvents = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_created", (q: any) => q.eq("taskId", args.taskId))
      .collect();

    for (const link of links) {
      if (link.kind !== "linear_issue" && link.kind !== "slack_thread") {
        continue;
      }
      const linkKind: LifecycleReplyLinkKind =
        link.kind === "linear_issue" ? "linear_issue" : "slack_thread";

      const claimEventKey = taskPullRequestStatusReplyEventKey({
        pullRequestExternalId: args.pullRequestExternalId,
        linkId: String(link._id),
      });
      const existingClaim = await ctx.db
        .query("taskEvents")
        .withIndex("by_event_key", (q: any) => q.eq("eventKey", claimEventKey))
        .unique();
      if (existingClaim !== null) {
        continue;
      }
      if (
        previousEvents.some((event) =>
          isPullRequestStatusReplyForLink({
            event,
            pullRequestExternalId: args.pullRequestExternalId,
            linkId: String(link._id),
          }),
        )
      ) {
        continue;
      }

      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: claimEventKey,
        kind: "pr-status-reply.claimed",
        summary: `Claimed pull request status reply for ${linkKind}.`,
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          linkId: link._id,
          kind: linkKind,
          externalId: link.externalId,
          pullRequestExternalId: args.pullRequestExternalId,
          pullRequestUrl: args.pullRequestUrl,
          ...(args.pullRequestStatus !== undefined
            ? { pullRequestStatus: args.pullRequestStatus }
            : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.headBranch !== undefined ? { headBranch: args.headBranch } : {}),
          ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
          ...(deploymentPreviews !== undefined ? { deploymentPreviews } : {}),
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: linkKind,
        externalId: link.externalId,
        body,
        pullRequestUrl: args.pullRequestUrl,
        ...(args.pullRequestStatus !== undefined
          ? { pullRequestStatus: args.pullRequestStatus }
          : {}),
        title: args.title ?? task.title,
        repo: args.repo ?? `${project.githubOwner}/${project.githubRepo}`,
        ...(args.headBranch !== undefined
          ? { branch: args.headBranch }
          : taskThread.branch !== undefined
            ? { branch: taskThread.branch }
            : {}),
        t3ThreadId: workSession.t3ThreadId,
        ...(workSession.environmentId !== undefined
          ? { environmentId: workSession.environmentId }
          : {}),
        ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
        ...(deploymentPreviews !== undefined ? { deploymentPreviews } : {}),
      });
    }

    return claimed;
  },
});

export const claimTaskStartedStatusReplies = internalMutation({
  args: {
    taskId: v.id("tasks"),
    t3ThreadId: v.string(),
    environmentId: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      linkId: v.id("taskExternalLinks"),
      kind: v.literal("slack_thread"),
      externalId: v.string(),
      t3ThreadId: v.string(),
      environmentId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];

    for (const link of links) {
      if (link.muted || link.kind !== "slack_thread") {
        continue;
      }

      const claimEventKey = taskStartedStatusReplyEventKey({
        taskId: String(args.taskId),
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
        kind: "task-started-status-reply.claimed",
        summary: "Claimed task started Slack status card.",
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          linkId: link._id,
          kind: link.kind,
          externalId: link.externalId,
          t3ThreadId: args.t3ThreadId,
          ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: link.kind,
        externalId: link.externalId,
        t3ThreadId: args.t3ThreadId,
        ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
      });
    }

    return claimed;
  },
});

export const claimTaskAssistantMessageReplies = internalMutation({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    occurredAt: v.string(),
    t3ThreadId: v.string(),
    t3MessageId: v.string(),
    t3TurnId: v.optional(v.string()),
    assistantMessage: v.string(),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      workSessionId: v.id("workSessions"),
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

    const body = args.assistantMessage.trim();
    if (!body) {
      return [];
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];

    for (const link of links) {
      if (!(await canDeliverToExternalLink(ctx, { taskId: args.taskId, link, now }))) {
        continue;
      }
      const linkKind: LifecycleReplyLinkKind =
        link.kind === "linear_issue" ? "linear_issue" : "slack_thread";

      const claimEventKey = taskAssistantMessageReplyEventKey({
        workSessionId: String(args.workSessionId),
        t3MessageId: args.t3MessageId,
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
        kind: "assistant-message-reply.claimed",
        summary: `Claimed assistant message reply for ${linkKind}.`,
        payloadJson: JSON.stringify({
          eventId: args.eventId,
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          linkId: link._id,
          kind: linkKind,
          externalId: link.externalId,
          occurredAt: args.occurredAt,
          t3ThreadId: args.t3ThreadId,
          t3MessageId: args.t3MessageId,
          ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        linkId: link._id,
        kind: linkKind,
        externalId: link.externalId,
        body,
      });
    }

    return claimed;
  },
});

export const claimTaskUserInputRequestReplies = internalMutation({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    occurredAt: v.string(),
    t3ThreadId: v.string(),
    t3TurnId: v.optional(v.string()),
    requestId: v.string(),
    questionsJson: v.string(),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      workSessionId: v.id("workSessions"),
      linkId: v.id("taskExternalLinks"),
      kind: v.literal("slack_thread"),
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

    const questions = JSON.parse(args.questionsJson) as Array<{
      readonly id: string;
      readonly header: string;
      readonly question: string;
      readonly options?: ReadonlyArray<{
        readonly label: string;
        readonly description: string;
      }>;
      readonly multiSelect?: boolean;
    }>;
    const body = buildTaskUserInputRequestReplyBody({ questions });
    const requestEventKey = taskUserInputRequestEventKey({
      workSessionId: String(args.workSessionId),
      requestId: args.requestId,
    });
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const existingRequest = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", requestEventKey))
      .unique();
    if (existingRequest === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: requestEventKey,
        kind: "user-input.requested",
        summary: "Provider requested user input.",
        payloadJson: JSON.stringify({
          eventId: args.eventId,
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          occurredAt: args.occurredAt,
          t3ThreadId: args.t3ThreadId,
          ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
          requestId: args.requestId,
          questions,
        }),
        createdAt: now,
      });
      await ctx.db.patch(args.taskId, {
        status: "needs_input",
        updatedAt: now,
      });
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const claimed = [];

    for (const link of links) {
      if (link.kind !== "slack_thread") {
        continue;
      }

      const claimEventKey = taskUserInputRequestReplyEventKey({
        workSessionId: String(args.workSessionId),
        requestId: args.requestId,
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
        kind: "user-input-request-reply.claimed",
        summary: "Claimed user-input request reply for Slack.",
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          workSessionId: args.workSessionId,
          linkId: link._id,
          kind: link.kind,
          externalId: link.externalId,
          requestId: args.requestId,
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        linkId: link._id,
        kind: "slack_thread" as const,
        externalId: link.externalId,
        body,
      });
    }

    return claimed;
  },
});

export const findOpenTaskUserInputForExternalLink = internalQuery({
  args: {
    kind: v.literal("slack_thread"),
    externalId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      taskId: v.id("tasks"),
      workSessionId: v.id("workSessions"),
      t3ThreadId: v.string(),
      t3TurnId: v.optional(v.string()),
      requestId: v.string(),
      questionsJson: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_kind_external_id", (q: any) =>
        q.eq("kind", args.kind).eq("externalId", args.externalId),
      )
      .unique();
    if (link === null) {
      return null;
    }

    const events = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_created", (q: any) => q.eq("taskId", link.taskId))
      .order("desc")
      .take(100);
    const resolvedRequestIds = new Set<string>();
    for (const event of events) {
      if (event.kind !== "user-input.resolved" || event.payloadJson === undefined) {
        continue;
      }
      try {
        const payload = JSON.parse(event.payloadJson) as { readonly requestId?: unknown };
        if (typeof payload.requestId === "string") {
          resolvedRequestIds.add(payload.requestId);
        }
      } catch {
        // Ignore malformed historical payloads.
      }
    }

    for (const event of events) {
      if (event.kind !== "user-input.requested" || event.payloadJson === undefined) {
        continue;
      }
      try {
        const payload = JSON.parse(event.payloadJson) as {
          readonly workSessionId?: unknown;
          readonly t3ThreadId?: unknown;
          readonly t3TurnId?: unknown;
          readonly requestId?: unknown;
          readonly questions?: unknown;
        };
        if (
          typeof payload.requestId !== "string" ||
          typeof payload.workSessionId !== "string" ||
          typeof payload.t3ThreadId !== "string" ||
          resolvedRequestIds.has(payload.requestId)
        ) {
          continue;
        }
        return {
          taskId: link.taskId,
          workSessionId: payload.workSessionId as any,
          t3ThreadId: payload.t3ThreadId,
          ...(typeof payload.t3TurnId === "string" ? { t3TurnId: payload.t3TurnId } : {}),
          requestId: payload.requestId,
          questionsJson: JSON.stringify(Array.isArray(payload.questions) ? payload.questions : []),
        };
      } catch {
        // Ignore malformed historical payloads.
      }
    }

    return null;
  },
});

export const recordTaskUserInputRequestReplyDelivered = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
    externalMessageId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: `${args.claimEventKey}:delivered`,
      kind: "user-input-request-reply.delivered",
      summary: "Delivered user-input request reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        externalMessageId: args.externalMessageId,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
    return null;
  },
});

export const recordTaskUserInputRequestReplyFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: `${args.claimEventKey}:failed`,
      kind: "user-input-request-reply.failed",
      summary: "Failed to deliver user-input request reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        error: args.error,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
    return null;
  },
});

export const claimTaskUserInputAnswer = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    requestId: v.string(),
    sourceEventId: v.string(),
    answerText: v.string(),
  },
  returns: v.object({
    claimed: v.boolean(),
    eventKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const eventKey = taskUserInputAnswerEventKey({
      workSessionId: String(args.workSessionId),
      requestId: args.requestId,
      sourceEventId: args.sourceEventId,
    });
    const existing = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", eventKey))
      .unique();
    if (existing !== null) {
      return { claimed: false, eventKey };
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey,
      kind: "user-input-answer.claimed",
      summary: "Claimed Slack answer for provider user-input request.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        requestId: args.requestId,
        sourceEventId: args.sourceEventId,
        answerPreview:
          args.answerText.length > 240 ? `${args.answerText.slice(0, 237)}...` : args.answerText,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
    return { claimed: true, eventKey };
  },
});

export const recordTaskUserInputResolved = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    requestId: v.string(),
    answerEventKey: v.string(),
    answersJson: v.string(),
    externalMessageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: `${args.answerEventKey}:resolved`,
      kind: "user-input.resolved",
      summary: "Provider user-input request answered from Slack.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        requestId: args.requestId,
        answers: JSON.parse(args.answersJson),
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: now,
    });
    await ctx.db.patch(args.taskId, {
      status: "working",
      updatedAt: now,
    });
    return null;
  },
});

export const claimGitHubDeploymentReadyReplies = internalMutation({
  args: {
    taskId: v.id("tasks"),
    deploymentId: v.string(),
    environment: v.optional(v.string()),
    url: v.string(),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      linkId: v.id("taskExternalLinks"),
      kind: lifecycleReplyLinkKind,
      externalId: v.string(),
      environment: v.optional(v.string()),
      url: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];

    for (const link of links) {
      if (!(await canDeliverToExternalLink(ctx, { taskId: args.taskId, link, now }))) {
        continue;
      }
      const linkKind: LifecycleReplyLinkKind =
        link.kind === "linear_issue" ? "linear_issue" : "slack_thread";

      const claimEventKey = githubDeploymentReadyReplyEventKey({
        taskId: String(args.taskId),
        deploymentId: args.deploymentId,
        url: args.url,
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
        kind: "github-deployment-ready-reply.claimed",
        summary: `Claimed GitHub deployment ready reply for ${linkKind}.`,
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          linkId: link._id,
          kind: linkKind,
          externalId: link.externalId,
          deploymentId: args.deploymentId,
          ...(args.environment !== undefined ? { environment: args.environment } : {}),
          url: args.url,
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: linkKind,
        externalId: link.externalId,
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
        url: args.url,
      });
    }

    return claimed;
  },
});

export const claimGitHubPullRequestMergedNotifications = internalMutation({
  args: {
    taskId: v.id("tasks"),
    pullRequestExternalId: v.string(),
    pullRequestUrl: v.string(),
  },
  returns: v.array(
    v.object({
      claimEventKey: v.string(),
      taskId: v.id("tasks"),
      linkId: v.id("taskExternalLinks"),
      kind: lifecycleReplyLinkKind,
      externalId: v.string(),
      pullRequestUrl: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const links = await ctx.db
      .query("taskExternalLinks")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .collect();
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const claimed = [];

    for (const link of links) {
      if (!(await canDeliverToExternalLink(ctx, { taskId: args.taskId, link, now }))) {
        continue;
      }
      const linkKind: LifecycleReplyLinkKind =
        link.kind === "linear_issue" ? "linear_issue" : "slack_thread";

      const claimEventKey = githubPullRequestMergedNotificationEventKey({
        taskId: String(args.taskId),
        pullRequestExternalId: args.pullRequestExternalId,
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
        kind: "github-pr-merged-notification.claimed",
        summary: `Claimed GitHub PR merged notification for ${linkKind}.`,
        payloadJson: JSON.stringify({
          taskId: args.taskId,
          linkId: link._id,
          kind: linkKind,
          externalId: link.externalId,
          pullRequestExternalId: args.pullRequestExternalId,
          pullRequestUrl: args.pullRequestUrl,
        }),
        createdAt: now,
      });

      claimed.push({
        claimEventKey,
        taskId: args.taskId,
        linkId: link._id,
        kind: linkKind,
        externalId: link.externalId,
        pullRequestUrl: args.pullRequestUrl,
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
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskPullRequestStatusReplyDelivered = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "pr-status-reply.delivered",
      summary: "Delivered pull request status reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskStartedStatusReplyDelivered = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "task-started-status-reply.delivered",
      summary: "Delivered task started Slack status card.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskAssistantMessageReplyDelivered = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "assistant-message-reply.delivered",
      summary: "Delivered assistant message reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        workSessionId: args.workSessionId,
        linkId: args.linkId,
        ...(args.externalMessageId !== undefined
          ? { externalMessageId: args.externalMessageId }
          : {}),
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
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
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskPullRequestStatusReplyFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "pr-status-reply.failed",
      summary: "Failed to deliver pull request status reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        error: args.error,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskStartedStatusReplyFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "task-started-status-reply.failed",
      summary: "Failed to deliver task started Slack status card.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        linkId: args.linkId,
        error: args.error,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    return null;
  },
});

export const recordTaskAssistantMessageReplyFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    claimEventKey: v.string(),
    linkId: v.id("taskExternalLinks"),
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
      kind: "assistant-message-reply.failed",
      summary: "Failed to deliver assistant message reply.",
      payloadJson: JSON.stringify({
        claimEventKey: args.claimEventKey,
        workSessionId: args.workSessionId,
        linkId: args.linkId,
        error: args.error,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
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
