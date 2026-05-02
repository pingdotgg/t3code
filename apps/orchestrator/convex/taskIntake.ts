"use node";

import { v } from "convex/values";

import { createTaskIntakeChatSdkBot } from "../src/taskIntake/chatSdk.ts";
import { buildTaskIntakeLifecycleReply } from "../src/taskIntake/replies.ts";
import { handleTaskIntakeMessage } from "../src/taskIntake/ingress.ts";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction } from "./_generated/server.js";

const headerArg = v.object({
  name: v.string(),
  value: v.string(),
});

export const handleChatSdkWebhook = internalAction({
  args: {
    source: v.union(v.literal("linear"), v.literal("slack")),
    url: v.string(),
    headers: v.array(headerArg),
    body: v.string(),
  },
  returns: v.object({
    status: v.number(),
    body: v.string(),
    contentType: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const bot = createTaskIntakeChatSdkBot({
      async onMessage({ thread, intakeMessage }) {
        await handleTaskIntakeMessage(intakeMessage, {
          store: {
            async resolveMessage(input) {
              return ctx.runMutation(internal.tasks.resolveTaskIntakeMessage, {
                eventId: input.message.eventId,
                source: input.message.source,
                externalLinkKind: input.externalLink.kind,
                externalId: input.externalLink.externalId,
                title: input.title,
                text: input.message.text,
                messageId: input.message.messageId,
                receivedAt: input.message.receivedAt,
                ...(input.message.url !== undefined ? { url: input.message.url } : {}),
                ...(input.message.conversation.teamId !== undefined
                  ? { teamId: input.message.conversation.teamId }
                  : {}),
                ...(input.message.conversation.channelId !== undefined
                  ? { channelId: input.message.conversation.channelId }
                  : {}),
                ...(input.message.conversation.issueId !== undefined
                  ? { issueId: input.message.conversation.issueId }
                  : {}),
                ...(input.message.conversation.commentId !== undefined
                  ? { commentId: input.message.conversation.commentId }
                  : {}),
                ...(input.message.actor?.displayName !== undefined
                  ? { actorDisplayName: input.message.actor.displayName }
                  : {}),
              });
            },
            async recordStartFailed(input) {
              await ctx.runMutation(internal.tasks.markTaskIntakeStartFailed, {
                eventId: input.message.eventId,
                taskId: input.taskId as Id<"tasks">,
                source: input.message.source,
                summary: input.summary,
              });
            },
          },
          runtime: {
            async materializeTaskRuntime(input) {
              return ctx.runAction(api.t3Runtime.materializeTaskRuntime, {
                taskId: input.taskId as Id<"tasks">,
                initialPrompt: input.initialPrompt,
                startCodingAgent: input.startCodingAgent,
              });
            },
          },
          replies: {
            async postReply(reply) {
              const posted = await thread.post(reply.body);
              return {
                status: "posted",
                externalMessageId: posted.id,
              };
            },
          },
        });
      },
    });

    const request = new Request(args.url, {
      method: "POST",
      headers: new Headers(args.headers.map((header) => [header.name, header.value])),
      body: args.body,
    });

    if (args.source === "slack") {
      return {
        status: 503,
        body: JSON.stringify({ error: "Slack Chat SDK adapter is not configured yet." }),
        contentType: "application/json",
      };
    }

    if (bot.webhooks.linear === undefined) {
      throw new Error("Linear Chat SDK webhook handler is not configured.");
    }

    const pendingTasks: Promise<unknown>[] = [];
    const response = await bot.webhooks.linear(request, {
      waitUntil(task) {
        pendingTasks.push(task);
      },
    });
    await Promise.all(pendingTasks);
    const contentType = response.headers.get("content-type") ?? undefined;

    return {
      status: response.status,
      body: await response.text(),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  },
});

export const postTaskRuntimeLifecycleReply = internalAction({
  args: {
    taskId: v.id("tasks"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    t3ThreadId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly posted: boolean;
    readonly reason?: string;
    readonly externalMessageId?: string;
  }> => {
    const seed = (await ctx.runQuery(internal.tasks.getTaskIntakeLifecycleReplySeed, {
      taskId: args.taskId,
    })) as null | {
      readonly taskId: Id<"tasks">;
      readonly source: "linear" | "slack" | "support_email" | "webhook";
      readonly externalLinkKind:
        | "linear_issue"
        | "slack_thread"
        | "support_email_thread"
        | "webhook_event"
        | "github_pr";
      readonly externalId: string;
      readonly muted: boolean;
      readonly t3ThreadId?: string;
    };
    if (seed === null) {
      return { posted: false, reason: "no_intake_link" };
    }
    if (seed.muted) {
      return { posted: false, reason: "muted" };
    }
    if (seed.source !== "linear" || seed.externalLinkKind !== "linear_issue") {
      return { posted: false, reason: "source_not_configured" };
    }

    const message = {
      eventId: `task-runtime:${String(args.taskId)}:${args.status}`,
      source: "linear" as const,
      conversation: {
        source: "linear" as const,
        externalLinkKind: "linear_issue" as const,
        externalId: seed.externalId,
        issueId: seed.externalId,
      },
      messageId: `task-runtime:${String(args.taskId)}:${args.status}`,
      text: "",
      receivedAt: new Date().toISOString(),
    };
    const reply = buildTaskIntakeLifecycleReply({
      message,
      status: args.status,
      taskId: String(args.taskId),
      ...((args.t3ThreadId ?? seed.t3ThreadId) !== undefined
        ? { t3ThreadId: args.t3ThreadId ?? seed.t3ThreadId }
        : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
    });

    const bot = createTaskIntakeChatSdkBot({
      async onMessage() {},
    });
    await bot.initialize();
    const posted: { readonly id: string } = await bot
      .thread(`linear:${seed.externalId}`)
      .post(reply.body);
    await ctx.runMutation(internal.tasks.recordTaskIntakeLifecycleReplyPosted, {
      taskId: args.taskId,
      eventKey: reply.idempotencyKey,
      status: args.status,
      externalMessageId: posted.id,
    });

    return {
      posted: true,
      externalMessageId: posted.id,
    };
  },
});
