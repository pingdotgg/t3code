"use node";

import { v } from "convex/values";

import { createLinearPlatformAdapter } from "../src/adapters/linear.ts";
import { handleTaskIntakeMessage } from "../src/taskIntake/ingress.ts";
import { linearIngressToTaskIntakeMessage } from "../src/taskIntake/linear.ts";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction } from "./_generated/server.js";

interface LinearIngressResult {
  readonly accepted: boolean;
  readonly ignored: boolean;
  readonly taskId?: string;
  readonly t3ThreadId?: string;
  readonly reason?: string;
}

export const handleLinearWebhookIngress = internalAction({
  args: {
    eventId: v.string(),
    linearThreadKey: v.string(),
    issueId: v.string(),
    issueIdentifier: v.optional(v.string()),
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
  },
  returns: v.object({
    accepted: v.boolean(),
    ignored: v.boolean(),
    taskId: v.optional(v.string()),
    t3ThreadId: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<LinearIngressResult> => {
    if (!args.shouldStartRun) {
      return {
        accepted: true,
        ignored: true,
        reason: "linear_ingress_not_task_trigger",
      };
    }

    const adapter = createLinearPlatformAdapter();
    const intakeMessage = linearIngressToTaskIntakeMessage(args);
    const result = await handleTaskIntakeMessage(intakeMessage, {
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
          const posted = await adapter.postMessage(
            {
              platform: "linear",
              issueId: args.issueId,
              ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
            },
            {
              markdown: reply.body,
            },
          );

          return {
            status: "posted",
            externalMessageId: posted.messageId,
          };
        },
      },
    });

    return {
      accepted: result.accepted,
      ignored: result.ignored,
      ...(result.taskId !== undefined ? { taskId: result.taskId } : {}),
      ...(result.t3ThreadId !== undefined ? { t3ThreadId: result.t3ThreadId } : {}),
    };
  },
});
