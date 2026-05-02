"use node";

import { v } from "convex/values";

import { createTaskIntakeChatSdkBot } from "../src/taskIntake/chatSdk.ts";
import { handleTaskIntakeMessage } from "../src/taskIntake/ingress.ts";
import { chatSdkThreadIdForLifecycleReply } from "../src/taskIntake/lifecycleReplies.ts";
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
      sources: new Set([args.source]),
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
            async continueTaskRuntime(input) {
              return ctx.runAction(api.t3Runtime.continueTaskRuntime, {
                eventId: input.eventId,
                taskId: input.taskId as Id<"tasks">,
                workSessionId: input.workSessionId as Id<"workSessions">,
                t3ThreadId: input.t3ThreadId,
                prompt: input.prompt,
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

    const webhook = args.source === "linear" ? bot.webhooks.linear : bot.webhooks.slack;
    if (webhook === undefined) {
      throw new Error(`${args.source} Chat SDK webhook handler is not configured.`);
    }

    const pendingTasks: Promise<unknown>[] = [];
    const response = await webhook(request, {
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
    workSessionId: v.id("workSessions"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    occurredAt: v.string(),
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
    const claims = await ctx.runMutation(internal.taskEvents.claimTaskLifecycleReplies, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      status: args.status,
      occurredAt: args.occurredAt,
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
    });
    if (claims.length === 0) {
      return { posted: false, reason: "no_unclaimed_intake_links" };
    }

    const bot = createTaskIntakeChatSdkBot({
      sources: new Set(claims.map((claim) => (claim.kind === "linear_issue" ? "linear" : "slack"))),
      async onMessage() {},
    });
    await bot.initialize();

    const postedIds: string[] = [];
    for (const claim of claims) {
      try {
        const posted: { readonly id: string } = await bot
          .thread(
            chatSdkThreadIdForLifecycleReply({
              kind: claim.kind,
              externalId: claim.externalId,
            }),
          )
          .post(claim.body);
        postedIds.push(posted.id);
        await ctx.runMutation(internal.taskEvents.recordTaskLifecycleReplyDelivered, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          status: args.status,
          externalMessageId: posted.id,
        });
      } catch (error) {
        await ctx.runMutation(internal.taskEvents.recordTaskLifecycleReplyFailed, {
          taskId: claim.taskId,
          claimEventKey: claim.claimEventKey,
          linkId: claim.linkId,
          status: args.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (postedIds.length === 0) {
      return { posted: false, reason: "all_lifecycle_replies_failed" };
    }
    return {
      posted: true,
      ...(postedIds[0] !== undefined ? { externalMessageId: postedIds[0] } : {}),
    };
  },
});
