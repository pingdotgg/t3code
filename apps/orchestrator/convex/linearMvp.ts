import { v } from "convex/values";

import { postLinearComment } from "../src/linear/client.ts";
import { buildLinearExecutionPrompt, buildLinearLifecycleReply } from "../src/linear/replies.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

interface StartRunFromLinearWebhookResult {
  readonly acceptedAt: string;
  readonly controlThreadId: string;
  readonly executionRunId: string;
  readonly t3ThreadId: string;
}

interface PostExecutionReplyIfNeededResult {
  readonly posted: boolean;
  readonly reason: string;
  readonly replyCommentId?: string;
}

interface ExecutionRunForReply {
  readonly controlThreadId: Id<"controlThreads">;
  readonly executionRunId: string;
  readonly failureSummary?: string;
  readonly linearReplyCommentId?: string;
  readonly status: "requested" | "accepted" | "started" | "completed" | "failed";
  readonly t3ThreadId?: string;
}

export const startRunFromLinearWebhook = internalAction({
  args: {
    controlThreadId: v.id("controlThreads"),
    issueId: v.string(),
    linearThreadKey: v.string(),
    messageId: v.optional(v.string()),
    authorName: v.optional(v.string()),
    body: v.string(),
    commentUrl: v.optional(v.string()),
  },
  returns: v.object({
    controlThreadId: v.string(),
    executionRunId: v.string(),
    t3ThreadId: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args): Promise<StartRunFromLinearWebhookResult> => {
    const workspaceRoot = process.env.LINEAR_DEFAULT_WORKSPACE_ROOT?.trim();
    if (!workspaceRoot) {
      throw new Error(
        "Missing LINEAR_DEFAULT_WORKSPACE_ROOT. Set it before testing the Linear MVP trigger path.",
      );
    }

    const initialPrompt = buildLinearExecutionPrompt({
      issueId: args.issueId,
      linearThreadKey: args.linearThreadKey,
      body: args.body,
      ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
      ...(args.authorName !== undefined ? { authorName: args.authorName } : {}),
      ...(args.commentUrl !== undefined ? { commentUrl: args.commentUrl } : {}),
    });

    const accepted = await ctx.runAction(internal.executionRuns.startSingleWorkerRun, {
      controlThreadId: args.controlThreadId,
      initialPrompt,
      workspaceRoot,
      title: `Linear ${args.issueId}`,
    });
    return accepted;
  },
});

export const postExecutionReplyIfNeeded = internalAction({
  args: {
    executionRunId: v.string(),
  },
  returns: v.object({
    posted: v.boolean(),
    reason: v.string(),
    replyCommentId: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<PostExecutionReplyIfNeededResult> => {
    const run = (await ctx.runQuery(internal.executionRuns.getExecutionRun, {
      executionRunId: args.executionRunId,
    })) as ExecutionRunForReply | null;
    if (run === null) {
      return {
        posted: false,
        reason: "missing_execution_run",
      };
    }

    if (run.status !== "completed" && run.status !== "failed") {
      return {
        posted: false,
        reason: "run_not_final",
      };
    }

    if (run.linearReplyCommentId !== undefined) {
      return {
        posted: false,
        reason: "already_posted",
        replyCommentId: run.linearReplyCommentId,
      };
    }

    const controlThread = await ctx.runQuery(internal.controlThreads.getControlThread, {
      controlThreadId: run.controlThreadId,
    });
    if (controlThread === null) {
      return {
        posted: false,
        reason: "missing_control_thread",
      };
    }

    const replyBody = buildLinearLifecycleReply({
      executionRunId: run.executionRunId,
      status: run.status,
      ...(run.t3ThreadId !== undefined ? { t3ThreadId: run.t3ThreadId } : {}),
      ...(run.failureSummary !== undefined ? { failureSummary: run.failureSummary } : {}),
    });
    const comment = await postLinearComment({
      issueId: controlThread.issueId,
      body: replyBody,
      ...(controlThread.commentId !== undefined ? { parentId: controlThread.commentId } : {}),
    });

    await ctx.runMutation(internal.executionRuns.recordLinearReplyPosted, {
      executionRunId: run.executionRunId,
      replyCommentId: comment.commentId,
      postedAt: Date.now(),
      bodyPreview: comment.body.slice(0, 240),
    });

    return {
      posted: true,
      reason: "posted",
      replyCommentId: comment.commentId,
    };
  },
});
