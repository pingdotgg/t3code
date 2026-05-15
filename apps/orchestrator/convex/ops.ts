"use node";

import { v } from "convex/values";

import { createTaskIntakeChatSdkBot } from "../src/taskIntake/chatSdk.ts";
import { createConvexChatSdkState } from "../src/taskIntake/convexChatSdkState.ts";
import { postableOpsHealthAlert } from "../src/taskIntake/postableReply.ts";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";

const healthCheckResult = v.object({
  name: v.string(),
  ok: v.boolean(),
  details: v.string(),
});

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function configuredOpsSlackChannelId() {
  const channelId = process.env.T3_OPS_SLACK_ALERT_CHANNEL_ID?.trim();
  if (!channelId) {
    throw new Error("Missing T3_OPS_SLACK_ALERT_CHANNEL_ID.");
  }
  return channelId.startsWith("slack:") ? channelId : `slack:${channelId}`;
}

function chatSdkState(ctx: any) {
  return createConvexChatSdkState({
    subscribe(threadId) {
      return ctx.runMutation(internal.chatSdkState.subscribe, { threadId });
    },
    unsubscribe(threadId) {
      return ctx.runMutation(internal.chatSdkState.unsubscribe, { threadId });
    },
    isSubscribed(threadId) {
      return ctx.runMutation(internal.chatSdkState.isSubscribed, { threadId });
    },
    acquireLock(input) {
      return ctx.runMutation(internal.chatSdkState.acquireLock, input);
    },
    releaseLock(lock) {
      return ctx.runMutation(internal.chatSdkState.releaseLock, {
        threadId: lock.threadId,
        token: lock.token,
      });
    },
    forceReleaseLock(threadId) {
      return ctx.runMutation(internal.chatSdkState.forceReleaseLock, { threadId });
    },
    extendLock(input) {
      return ctx.runMutation(internal.chatSdkState.extendLock, {
        threadId: input.lock.threadId,
        token: input.lock.token,
        ttlMs: input.ttlMs,
      });
    },
    get(key) {
      return ctx.runMutation(internal.chatSdkState.get, { key });
    },
    set(input) {
      return ctx.runMutation(internal.chatSdkState.set, input);
    },
    setIfNotExists(input) {
      return ctx.runMutation(internal.chatSdkState.setIfNotExists, input);
    },
    delete(key) {
      return ctx.runMutation(internal.chatSdkState.deleteKey, { key });
    },
    appendToList(input) {
      return ctx.runMutation(internal.chatSdkState.appendToList, input);
    },
    getList(key) {
      return ctx.runMutation(internal.chatSdkState.getList, { key });
    },
    enqueue(input) {
      return ctx.runMutation(internal.chatSdkState.enqueue, input);
    },
    dequeue(threadId) {
      return ctx.runMutation(internal.chatSdkState.dequeue, { threadId });
    },
    queueDepth(threadId) {
      return ctx.runMutation(internal.chatSdkState.queueDepth, { threadId });
    },
  });
}

async function logOpsEvent(
  ctx: any,
  input: {
    readonly kind: string;
    readonly severity?: "debug" | "info" | "warn" | "error" | undefined;
    readonly summary: string;
    readonly eventKey?: string | undefined;
    readonly externalId?: string | undefined;
    readonly payload?: unknown | undefined;
  },
) {
  console[input.severity === "error" ? "error" : input.severity === "warn" ? "warn" : "log"](
    input.kind,
    input,
  );
  await ctx.runMutation(internal.observability.append, {
    kind: input.kind,
    source: "ops",
    severity: input.severity ?? "info",
    summary: input.summary,
    ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.payload !== undefined ? { payloadJson: JSON.stringify(input.payload) } : {}),
  });
}

export const postHealthAlert = internalAction({
  args: {
    checkedAt: v.string(),
    status: v.union(v.literal("failing"), v.literal("recovered")),
    results: v.array(healthCheckResult),
    summary: v.optional(v.string()),
  },
  returns: v.object({
    posted: v.boolean(),
    channelId: v.optional(v.string()),
    externalMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const channelId = configuredOpsSlackChannelId();
    const failingChecks = args.results.filter((result) => !result.ok);
    const title =
      args.status === "recovered"
        ? "Vevin health recovered"
        : `Vevin health check failing (${failingChecks.length})`;
    const summary =
      args.summary ??
      (args.status === "recovered"
        ? "All orchestrator health checks are passing again."
        : "One or more orchestrator health checks failed.");

    await logOpsEvent(ctx, {
      kind: "ops.health-alert.delivery-started",
      summary: "Posting ops health alert to Slack.",
      externalId: channelId,
      payload: {
        status: args.status,
        checkedAt: args.checkedAt,
        failingChecks: failingChecks.map((check) => check.name),
      },
    });

    try {
      const bot = createTaskIntakeChatSdkBot({
        sources: new Set(["slack"]),
        state: chatSdkState(ctx),
        async onMessage() {},
      });
      await bot.initialize();
      const posted: { readonly id: string } = await bot.channel(channelId).post(
        postableOpsHealthAlert({
          title,
          summary,
          status: args.status,
          checkedAt: args.checkedAt,
          failingChecks,
          allChecks: args.results,
        }),
      );
      await logOpsEvent(ctx, {
        kind: "ops.health-alert.delivered",
        summary: "Delivered ops health alert to Slack.",
        eventKey: `ops-health-alert:${args.checkedAt}:${posted.id}`,
        externalId: channelId,
        payload: {
          status: args.status,
          externalMessageId: posted.id,
        },
      });
      return { posted: true, channelId, externalMessageId: posted.id };
    } catch (error) {
      const summary = errorSummary(error);
      await logOpsEvent(ctx, {
        kind: "ops.health-alert.delivery-failed",
        severity: "error",
        summary: "Failed to deliver ops health alert to Slack.",
        externalId: channelId,
        payload: {
          error: summary,
          status: args.status,
        },
      });
      return { posted: false, channelId, error: summary };
    }
  },
});
