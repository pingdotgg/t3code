import {
  type ExecutionRunCreateRequest,
  type RuntimeMode,
  type ModelSelection,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { v } from "convex/values";

import { createT3ExecutionBridgeClient } from "../src/t3/client.ts";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

type ExecutionRunStatus = "requested" | "accepted" | "started" | "completed" | "failed";

const createRequestedRunArgs = {
  controlThreadId: v.id("controlThreads"),
  executionRunId: v.string(),
  initialPrompt: v.string(),
  workspaceRoot: v.string(),
  title: v.optional(v.string()),
  runtimeMode: v.string(),
  interactionMode: v.string(),
  modelSelectionJson: v.optional(v.string()),
  requestedAt: v.number(),
} as const;

export const createRequestedRun = internalMutation({
  args: createRequestedRunArgs,
  returns: v.object({
    runDocId: v.id("executionRuns"),
  }),
  handler: async (ctx, args) => {
    const controlThread = await ctx.db.get(args.controlThreadId);
    if (controlThread === null) {
      throw new Error(`Control thread ${args.controlThreadId} does not exist`);
    }

    const existingRun = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (existingRun !== null) {
      return { runDocId: existingRun._id };
    }

    const runDocId = await ctx.db.insert("executionRuns", {
      executionRunId: args.executionRunId,
      controlThreadId: args.controlThreadId,
      status: "requested",
      initialPrompt: args.initialPrompt,
      workspaceRoot: args.workspaceRoot,
      runtimeMode: args.runtimeMode,
      interactionMode: args.interactionMode,
      requestedAt: args.requestedAt,
      updatedAt: args.requestedAt,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.modelSelectionJson !== undefined
        ? { modelSelectionJson: args.modelSelectionJson }
        : {}),
    });

    return { runDocId };
  },
});

export const attachT3Acceptance = internalMutation({
  args: {
    executionRunId: v.string(),
    t3ThreadId: v.string(),
    acceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (run === null) {
      throw new Error(`Execution run ${args.executionRunId} does not exist`);
    }

    await ctx.db.patch(run._id, {
      status: run.status === "requested" ? "accepted" : run.status,
      t3ThreadId: args.t3ThreadId,
      acceptedAt: args.acceptedAt,
      updatedAt: args.acceptedAt,
    });
    return null;
  },
});

export const applyLifecycleEvent = internalMutation({
  args: {
    eventId: v.string(),
    executionRunId: v.string(),
    controlThreadId: v.string(),
    type: v.union(v.literal("started"), v.literal("completed"), v.literal("failed")),
    occurredAt: v.string(),
    t3ThreadId: v.optional(v.string()),
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
  },
  returns: v.object({
    applied: v.boolean(),
    status: executionRunStateForReturns(),
  }),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("executionRunEvents")
      .withIndex("by_event_id", (query: any) => query.eq("eventId", args.eventId))
      .unique();
    if (existingEvent !== null) {
      const run = await ctx.db
        .query("executionRuns")
        .withIndex("by_execution_run_id", (query: any) =>
          query.eq("executionRunId", args.executionRunId),
        )
        .unique();
      return {
        applied: false,
        status: (run?.status ?? "failed") as ExecutionRunStatus,
      };
    }

    const run = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (run === null) {
      throw new Error(`Execution run ${args.executionRunId} does not exist`);
    }
    if (String(run.controlThreadId) !== args.controlThreadId) {
      throw new Error(
        `Execution run ${args.executionRunId} does not belong to control thread ${args.controlThreadId}`,
      );
    }

    const occurredAtMs = Date.parse(args.occurredAt);
    const nextStatus: ExecutionRunStatus =
      args.type === "started" ? "started" : args.type === "completed" ? "completed" : "failed";

    await ctx.db.insert("executionRunEvents", {
      eventId: args.eventId,
      executionRunId: args.executionRunId,
      controlThreadId: run.controlThreadId,
      type: args.type,
      payloadJson: JSON.stringify(args),
      createdAt: occurredAtMs,
    });

    // Event ids are the idempotency key. Once we've recorded one, retries can safely no-op.
    await ctx.db.patch(run._id, {
      status: nextStatus,
      updatedAt: occurredAtMs,
      lastEventId: args.eventId,
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
      ...(args.type === "started" ? { startedAt: occurredAtMs } : {}),
      ...(args.type === "completed" || args.type === "failed" ? { completedAt: occurredAtMs } : {}),
    });

    return {
      applied: true,
      status: nextStatus,
    };
  },
});

export const startSingleWorkerRun = internalAction({
  args: {
    controlThreadId: v.id("controlThreads"),
    initialPrompt: v.string(),
    workspaceRoot: v.string(),
    title: v.optional(v.string()),
    modelSelectionJson: v.optional(v.string()),
    runtimeMode: v.optional(
      v.union(
        v.literal("approval-required"),
        v.literal("auto-accept-edits"),
        v.literal("full-access"),
      ),
    ),
    interactionMode: v.optional(v.union(v.literal("default"), v.literal("plan"))),
  },
  returns: v.object({
    controlThreadId: v.string(),
    executionRunId: v.string(),
    t3ThreadId: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const executionRunId = crypto.randomUUID();
    const requestedAt = Date.now();
    const runtimeMode: RuntimeMode = args.runtimeMode ?? "full-access";
    const interactionMode: ProviderInteractionMode = args.interactionMode ?? "default";
    const request: ExecutionRunCreateRequest = {
      controlThreadId: String(args.controlThreadId),
      executionRunId,
      initialPrompt: args.initialPrompt,
      workspaceRoot: args.workspaceRoot,
      runtimeMode,
      interactionMode,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.modelSelectionJson !== undefined
        ? { modelSelection: JSON.parse(args.modelSelectionJson) as ModelSelection }
        : {}),
    };

    await ctx.runMutation(internal.executionRuns.createRequestedRun, {
      controlThreadId: args.controlThreadId,
      executionRunId,
      initialPrompt: args.initialPrompt,
      workspaceRoot: args.workspaceRoot,
      runtimeMode,
      interactionMode,
      requestedAt,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.modelSelectionJson !== undefined
        ? { modelSelectionJson: args.modelSelectionJson }
        : {}),
    });

    const client = createT3ExecutionBridgeClient();
    const accepted = await client.createExecutionRun(request);
    await ctx.runMutation(internal.executionRuns.attachT3Acceptance, {
      executionRunId,
      t3ThreadId: accepted.t3ThreadId,
      acceptedAt: Date.parse(accepted.acceptedAt),
    });
    return accepted;
  },
});

export const recordLinearReplyPosted = internalMutation({
  args: {
    executionRunId: v.string(),
    replyCommentId: v.string(),
    postedAt: v.number(),
    bodyPreview: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (run === null) {
      throw new Error(`Execution run ${args.executionRunId} does not exist`);
    }

    await ctx.db.patch(run._id, {
      linearReplyCommentId: args.replyCommentId,
      linearReplyPostedAt: args.postedAt,
      updatedAt: args.postedAt,
    });

    const existingMessage = await ctx.db
      .query("controlThreadMessages")
      .withIndex("by_external_message_key", (query: any) =>
        query.eq("externalMessageKey", args.replyCommentId),
      )
      .unique();
    if (existingMessage === null) {
      await ctx.db.insert("controlThreadMessages", {
        controlThreadId: run.controlThreadId,
        externalMessageKey: args.replyCommentId,
        authorName: process.env.LINEAR_BOT_USERNAME?.trim() || "Linear bot",
        bodyPreview: args.bodyPreview,
        createdAt: args.postedAt,
        updatedAt: args.postedAt,
      });
      return null;
    }

    await ctx.db.patch(existingMessage._id, {
      updatedAt: args.postedAt,
      authorName: process.env.LINEAR_BOT_USERNAME?.trim() || "Linear bot",
      bodyPreview: args.bodyPreview,
    });
    return null;
  },
});

export const recordLinearReplyError = internalMutation({
  args: {
    executionRunId: v.string(),
    errorMessage: v.string(),
    updatedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (run === null) {
      return null;
    }

    await ctx.db.patch(run._id, {
      linearReplyError: args.errorMessage,
      updatedAt: args.updatedAt,
    });
    return null;
  },
});

export const getExecutionRun = internalQuery({
  args: {
    executionRunId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      executionRunId: v.string(),
      controlThreadId: v.id("controlThreads"),
      status: executionRunStateForReturns(),
      t3ThreadId: v.optional(v.string()),
      t3TurnId: v.optional(v.string()),
      failureSummary: v.optional(v.string()),
      linearReplyCommentId: v.optional(v.string()),
      linearReplyError: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("executionRuns")
      .withIndex("by_execution_run_id", (query: any) =>
        query.eq("executionRunId", args.executionRunId),
      )
      .unique();
    if (run === null) {
      return null;
    }

    return {
      executionRunId: run.executionRunId,
      controlThreadId: run.controlThreadId,
      status: run.status,
      ...(run.t3ThreadId !== undefined ? { t3ThreadId: run.t3ThreadId } : {}),
      ...(run.t3TurnId !== undefined ? { t3TurnId: run.t3TurnId } : {}),
      ...(run.failureSummary !== undefined ? { failureSummary: run.failureSummary } : {}),
      ...(run.linearReplyCommentId !== undefined
        ? { linearReplyCommentId: run.linearReplyCommentId }
        : {}),
      ...(run.linearReplyError !== undefined ? { linearReplyError: run.linearReplyError } : {}),
    };
  },
});

function executionRunStateForReturns() {
  return v.union(
    v.literal("requested"),
    v.literal("accepted"),
    v.literal("started"),
    v.literal("completed"),
    v.literal("failed"),
  );
}
