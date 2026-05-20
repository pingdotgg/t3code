import { v } from "convex/values";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ModelSelection, ThreadId, type TaskRuntimeMaterializeResponse } from "@t3tools/contracts";

import { createT3ExecutionBridgeClient } from "../src/t3/client.ts";
import { internal, api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { action, internalMutation, internalQuery } from "./_generated/server.js";

const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const modelSelectionArg = v.object({
  instanceId: v.string(),
  model: v.string(),
  options: v.optional(
    v.array(
      v.object({
        id: v.string(),
        value: v.union(v.string(), v.boolean()),
      }),
    ),
  ),
});
const uploadImageAttachmentArg = v.object({
  type: v.literal("image"),
  name: v.string(),
  mimeType: v.string(),
  sizeBytes: v.number(),
  dataUrl: v.string(),
});

function errorSummary(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function extractGitHubPullRequests(text: string) {
  const results = new Map<
    string,
    {
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
      readonly url: string;
      readonly externalId: string;
    }
  >();
  const matcher = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;
  for (const match of text.matchAll(matcher)) {
    const owner = match[1];
    const repo = match[2];
    const numberText = match[3];
    if (owner === undefined || repo === undefined || numberText === undefined) continue;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const externalId = `${owner}/${repo}#${number}`;
    results.set(externalId, {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      externalId,
    });
  }
  return [...results.values()];
}

function logOrchestratorEvent(
  ctx: any,
  input: {
    readonly kind: string;
    readonly summary: string;
    readonly severity?: "debug" | "info" | "warn" | "error" | undefined;
    readonly eventKey?: string | undefined;
    readonly taskId?: Id<"tasks"> | undefined;
    readonly workSessionId?: Id<"workSessions"> | undefined;
    readonly externalId?: string | undefined;
    readonly payload?: unknown | undefined;
  },
) {
  console[input.severity === "error" ? "error" : input.severity === "warn" ? "warn" : "log"](
    input.kind,
    {
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: input.workSessionId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  );
  return ctx
    .runMutation(internal.observability.append, {
      kind: input.kind,
      source: "t3",
      severity: input.severity ?? "info",
      summary: input.summary,
      ...(input.eventKey !== undefined ? { eventKey: input.eventKey } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.workSessionId !== undefined ? { workSessionId: input.workSessionId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      ...(input.payload !== undefined ? { payloadJson: JSON.stringify(input.payload) } : {}),
    })
    .catch((error: unknown) => {
      console.warn("observability.append.failed", {
        kind: input.kind,
        error: errorSummary(error),
      });
    });
}

export const materializeTaskRuntime = action({
  args: {
    taskId: v.id("tasks"),
    initialPrompt: v.string(),
    attachments: v.optional(v.array(uploadImageAttachmentArg)),
    startCodingAgent: v.optional(v.boolean()),
    modelSelection: v.optional(modelSelectionArg),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    environmentId: v.optional(v.string()),
    branch: v.union(v.null(), v.string()),
    worktreePath: v.union(v.null(), v.string()),
    acceptedAt: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    taskId: string;
    workSessionId: string;
    t3ProjectId: string;
    t3ThreadId: string;
    environmentId?: string;
    branch: string | null;
    worktreePath: string | null;
    acceptedAt: string;
  }> => {
    const tree = await ctx.runQuery(api.tasks.getTaskRuntimeSeed, {
      taskId: args.taskId,
    });
    if (tree === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const requestedStartCodingAgent = args.startCodingAgent ?? true;
    const modelSelection =
      args.modelSelection === undefined ? undefined : decodeModelSelection(args.modelSelection);
    const workSessionSeed = await ctx.runMutation(internal.t3Runtime.prepareWorkSessionSeed, {
      taskId: args.taskId,
      startCodingAgent: requestedStartCodingAgent,
    });

    const client = createT3ExecutionBridgeClient();
    const idempotencyKey = `task-runtime:${String(args.taskId)}:${String(workSessionSeed.workSessionId)}`;
    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.materialize-requested",
      summary: "Calling local T3 bridge to materialize task runtime.",
      eventKey: `${idempotencyKey}:bridge-requested`,
      taskId: args.taskId,
      workSessionId: workSessionSeed.workSessionId,
      payload: {
        idempotencyKey,
        repoName: tree.project.repoName,
        workspaceRoot: tree.project.workspaceRoot,
        defaultBranch: tree.project.defaultBranch,
        startCodingAgent: requestedStartCodingAgent,
        attachmentCount: args.attachments?.length ?? 0,
        ...(modelSelection !== undefined
          ? {
              modelSelection: {
                instanceId: modelSelection.instanceId,
                model: modelSelection.model,
              },
            }
          : {}),
      },
    });

    let response: TaskRuntimeMaterializeResponse;
    try {
      response = await client.materializeTaskRuntime({
        taskId: String(args.taskId),
        workSessionId: String(workSessionSeed.workSessionId),
        initialPrompt: args.initialPrompt,
        ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
        title: tree.task.title,
        runtimeMode: "full-access",
        interactionMode: "default",
        startCodingAgent: requestedStartCodingAgent,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        idempotencyKey,
        project: {
          repoName: tree.project.repoName,
          workspaceRoot: tree.project.workspaceRoot,
          defaultBranch: tree.project.defaultBranch,
        },
      });
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : String(error);
      await logOrchestratorEvent(ctx, {
        kind: "t3.runtime.materialize-failed",
        severity: "error",
        summary: "Local T3 bridge failed to materialize task runtime.",
        eventKey: `${idempotencyKey}:bridge-failed`,
        taskId: args.taskId,
        workSessionId: workSessionSeed.workSessionId,
        payload: {
          idempotencyKey,
          failureSummary,
        },
      });
      await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeMaterializationFailed, {
        taskId: args.taskId,
        workSessionId: workSessionSeed.workSessionId,
        eventKey: `${idempotencyKey}:failed`,
        failureSummary,
        failedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      });
      throw error;
    }
    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.materialize-accepted",
      summary: "Local T3 bridge accepted task runtime materialization.",
      eventKey: `${idempotencyKey}:bridge-accepted`,
      taskId: args.taskId,
      workSessionId: workSessionSeed.workSessionId,
      payload: {
        idempotencyKey,
        t3ProjectId: String(response.t3ProjectId),
        t3ThreadId: String(response.t3ThreadId),
        branch: response.branch,
        worktreePath: response.worktreePath,
        environmentId: response.environment?.environmentId,
      },
    });

    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeMaterialized, {
      taskId: args.taskId,
      taskThreadId: workSessionSeed.taskThreadId,
      workSessionId: workSessionSeed.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
      eventKey: `${idempotencyKey}:materialized`,
      acceptedAt: Date.parse(response.acceptedAt),
      ...(response.branch !== null ? { branch: response.branch } : {}),
      ...(response.worktreePath !== null ? { worktreePath: response.worktreePath } : {}),
      ...(response.environment !== undefined
        ? { environmentId: String(response.environment.environmentId) }
        : {}),
      ...(process.env.T3_EXECUTION_BRIDGE_BASE_URL !== undefined
        ? { runtimeEndpointUrl: process.env.T3_EXECUTION_BRIDGE_BASE_URL }
        : {}),
    });

    return {
      taskId: response.taskId,
      workSessionId: response.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
      ...(response.environment !== undefined
        ? { environmentId: String(response.environment.environmentId) }
        : {}),
      branch: response.branch ?? null,
      worktreePath: response.worktreePath ?? null,
      acceptedAt: response.acceptedAt,
    };
  },
});

export const startMaterializedTaskRuntimeAgent = action({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    initialPrompt: v.string(),
  },
  returns: v.object({
    started: v.boolean(),
    t3ThreadId: v.optional(v.string()),
    acceptedAt: v.optional(v.string()),
    skippedReason: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    readonly started: boolean;
    readonly t3ThreadId?: string;
    readonly acceptedAt?: string;
    readonly skippedReason?: string;
  }> => {
    const seed = await ctx.runQuery(internal.t3Runtime.getTaskRuntimeAgentStartSeed, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
    });
    if (seed === null) {
      return { started: false, skippedReason: "Task runtime is not materialized yet." };
    }
    if (seed.runtimeEndpointUrl === undefined) {
      return { started: false, skippedReason: "Task runtime does not have a bridge endpoint." };
    }
    if (seed.worktreePath === undefined) {
      return { started: false, skippedReason: "Task runtime does not have a worktree path." };
    }

    const eventKey = `task-runtime-agent:start:${String(args.taskId)}:${String(args.workSessionId)}`;
    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeAgentStartRequested, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      eventKey: `${eventKey}:requested`,
      requestedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });

    const client = createT3ExecutionBridgeClient();

    try {
      await logOrchestratorEvent(ctx, {
        kind: "t3.runtime.agent-start-requested",
        summary: "Calling local T3 bridge to start materialized coding agent.",
        eventKey: `${eventKey}:bridge-requested`,
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        payload: {
          workspaceRoot: seed.worktreePath,
          title: seed.title,
        },
      });
      const response = await client.createExecutionRun({
        controlThreadId: String(args.taskId),
        executionRunId: String(args.workSessionId),
        initialPrompt: args.initialPrompt,
        workspaceRoot: seed.worktreePath,
        title: seed.title,
        taskRuntime: true,
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeAgentStartAccepted, {
        taskId: args.taskId,
        taskThreadId: seed.taskThreadId,
        workSessionId: args.workSessionId,
        t3ThreadId: String(response.t3ThreadId),
        eventKey: `${eventKey}:accepted`,
        acceptedAt: Date.parse(response.acceptedAt),
      });
      await logOrchestratorEvent(ctx, {
        kind: "t3.runtime.agent-start-accepted",
        summary: "Local T3 bridge accepted materialized coding agent start.",
        eventKey: `${eventKey}:bridge-accepted`,
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        payload: {
          t3ThreadId: String(response.t3ThreadId),
          acceptedAt: response.acceptedAt,
        },
      });

      return {
        started: true,
        t3ThreadId: String(response.t3ThreadId),
        acceptedAt: response.acceptedAt,
      };
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : String(error);
      await logOrchestratorEvent(ctx, {
        kind: "t3.runtime.agent-start-failed",
        severity: "error",
        summary: "Local T3 bridge failed to start materialized coding agent.",
        eventKey: `${eventKey}:bridge-failed`,
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        payload: {
          failureSummary,
        },
      });
      await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeAgentStartFailed, {
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        eventKey: `${eventKey}:failed`,
        failureSummary,
        failedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      });
      throw error;
    }
  },
});

export const claimTaskRuntimeContinuation = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    eventKey: v.string(),
    claimedAt: v.number(),
  },
  returns: v.object({
    claimed: v.boolean(),
    claimedAt: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    claimed: boolean;
    claimedAt: number;
  }> => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return {
        claimed: false,
        claimedAt: existingEvent.createdAt,
      };
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: "runtime.continuation-claimed",
      summary: "Claimed T3 runtime continuation for the Task.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        t3ThreadId: args.t3ThreadId,
      }),
      createdAt: args.claimedAt,
    });
    return {
      claimed: true,
      claimedAt: args.claimedAt,
    };
  },
});

export const continueTaskRuntime = action({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    prompt: v.string(),
    attachments: v.optional(v.array(uploadImageAttachmentArg)),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ThreadId: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    taskId: string;
    workSessionId: string;
    t3ThreadId: string;
    acceptedAt: string;
  }> => {
    await ctx.runQuery(internal.t3Runtime.getTaskRuntimeContinuationRoute, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      t3ThreadId: args.t3ThreadId,
    });

    const claim: { claimed: boolean; claimedAt: number } = await ctx.runMutation(
      internal.t3Runtime.claimTaskRuntimeContinuation,
      {
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        t3ThreadId: args.t3ThreadId,
        eventKey: `${args.eventId}:runtime-continuation:claim`,
        claimedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
      },
    );
    if (!claim.claimed) {
      return {
        taskId: String(args.taskId),
        workSessionId: String(args.workSessionId),
        t3ThreadId: args.t3ThreadId,
        acceptedAt: new Date(claim.claimedAt).toISOString(),
      };
    }

    const client = createT3ExecutionBridgeClient();
    const t3ThreadId = decodeThreadId(args.t3ThreadId);
    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.continue-requested",
      summary: "Calling local T3 bridge to continue task runtime.",
      eventKey: `${args.eventId}:runtime-continuation:bridge-requested`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        t3ThreadId: args.t3ThreadId,
        promptPreview: args.prompt.slice(0, 120),
        attachmentCount: args.attachments?.length ?? 0,
      },
    });
    const response = await client.continueExecutionRun({
      controlThreadId: String(args.taskId),
      executionRunId: String(args.workSessionId),
      t3ThreadId,
      prompt: args.prompt,
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      taskRuntime: true,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeContinuationAccepted, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      t3ThreadId: String(response.t3ThreadId),
      eventKey: `${args.eventId}:runtime-continuation`,
      acceptedAt: Date.parse(response.acceptedAt),
    });
    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.continue-accepted",
      summary: "Local T3 bridge accepted task runtime continuation.",
      eventKey: `${args.eventId}:runtime-continuation:bridge-accepted`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        t3ThreadId: String(response.t3ThreadId),
        acceptedAt: response.acceptedAt,
      },
    });

    return {
      taskId: String(args.taskId),
      workSessionId: String(response.executionRunId),
      t3ThreadId: String(response.t3ThreadId),
      acceptedAt: response.acceptedAt,
    };
  },
});

export const respondTaskRuntimeUserInput = action({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    requestId: v.string(),
    answersJson: v.string(),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ThreadId: v.string(),
    requestId: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    taskId: string;
    workSessionId: string;
    t3ThreadId: string;
    requestId: string;
    acceptedAt: string;
  }> => {
    await ctx.runQuery(internal.t3Runtime.getTaskRuntimeContinuationRoute, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      t3ThreadId: args.t3ThreadId,
    });

    const client = createT3ExecutionBridgeClient();
    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.user-input-response-requested",
      summary: "Calling local T3 bridge to answer provider user-input request.",
      eventKey: `${args.eventId}:runtime-user-input:bridge-requested`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        t3ThreadId: args.t3ThreadId,
        requestId: args.requestId,
      },
    });
    const response = await client.respondToTaskRuntimeUserInput({
      taskId: String(args.taskId),
      workSessionId: String(args.workSessionId),
      t3ThreadId: decodeThreadId(args.t3ThreadId),
      requestId: args.requestId as any,
      answers: JSON.parse(args.answersJson) as Record<string, unknown>,
    });

    await logOrchestratorEvent(ctx, {
      kind: "t3.runtime.user-input-response-accepted",
      summary: "Local T3 bridge accepted provider user-input response.",
      eventKey: `${args.eventId}:runtime-user-input:bridge-accepted`,
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      payload: {
        t3ThreadId: String(response.t3ThreadId),
        requestId: String(response.requestId),
      },
    });

    return {
      taskId: String(response.taskId),
      workSessionId: String(response.workSessionId),
      t3ThreadId: String(response.t3ThreadId),
      requestId: String(response.requestId),
      acceptedAt: response.acceptedAt,
    };
  },
});

export const getTaskPullRequestSeed = internalQuery({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
  },
  returns: v.union(
    v.null(),
    v.object({
      title: v.string(),
      t3ThreadId: v.string(),
      branch: v.string(),
      worktreePath: v.string(),
      runtimeId: v.optional(v.string()),
      runtimeProviderKind: v.optional(v.literal("local")),
      environmentId: v.optional(v.string()),
      runtimeEndpointUrl: v.optional(v.string()),
      project: v.object({
        githubOwner: v.string(),
        githubRepo: v.string(),
        defaultBranch: v.string(),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return null;
    }
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null || String(workSession.taskId) !== String(args.taskId)) {
      return null;
    }
    const taskThread = await ctx.db.get(workSession.taskThreadId);
    const project = await ctx.db.get(task.projectId);
    if (
      taskThread?.branch === undefined ||
      taskThread.worktreePath === undefined ||
      project === null
    ) {
      return null;
    }

    return {
      title: task.title,
      t3ThreadId: workSession.t3ThreadId,
      branch: taskThread.branch,
      worktreePath: taskThread.worktreePath,
      ...(workSession.runtimeId !== undefined ? { runtimeId: workSession.runtimeId } : {}),
      ...(workSession.runtimeProviderKind !== undefined
        ? { runtimeProviderKind: workSession.runtimeProviderKind }
        : {}),
      ...(workSession.environmentId !== undefined
        ? { environmentId: workSession.environmentId }
        : {}),
      ...(workSession.runtimeEndpointUrl !== undefined
        ? { runtimeEndpointUrl: workSession.runtimeEndpointUrl }
        : {}),
      project: {
        githubOwner: project.githubOwner,
        githubRepo: project.githubRepo,
        defaultBranch: project.defaultBranch,
      },
    };
  },
});

export const recordTaskPullRequestRequested = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    eventKey: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: "task-pr.requested",
      summary: "Task pull request ensure was requested.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        reason: args.reason,
      }),
      createdAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    });
    return null;
  },
});

export const recordTaskPullRequestEnsureResult = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    eventKey: v.string(),
    status: v.union(
      v.literal("waiting_for_changes"),
      v.literal("created"),
      v.literal("existing"),
      v.literal("failed"),
    ),
    checkedAt: v.number(),
    summary: v.optional(v.string()),
    owner: v.optional(v.string()),
    repo: v.optional(v.string()),
    number: v.optional(v.number()),
    url: v.optional(v.string()),
    headBranch: v.optional(v.string()),
    baseBranch: v.optional(v.string()),
    title: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    headSha: v.optional(v.string()),
    previewUrl: v.optional(v.string()),
    deploymentPreviewsJson: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    if (
      (args.status === "created" || args.status === "existing") &&
      args.owner !== undefined &&
      args.repo !== undefined &&
      args.number !== undefined &&
      args.url !== undefined
    ) {
      const externalId = `${args.owner}/${args.repo}#${args.number}`;
      const existingLink = await ctx.db
        .query("taskExternalLinks")
        .withIndex("by_kind_external_id", (q: any) =>
          q.eq("kind", "github_pr").eq("externalId", externalId),
        )
        .unique();
      if (existingLink !== null) {
        await ctx.db.patch(existingLink._id, {
          taskId: args.taskId,
          url: args.url,
          updatedAt: args.checkedAt,
        });
      } else {
        await ctx.db.insert("taskExternalLinks", {
          taskId: args.taskId,
          kind: "github_pr",
          externalId,
          url: args.url,
          muted: false,
          createdAt: args.checkedAt,
          updatedAt: args.checkedAt,
        });
      }

      const existingPullRequest = await ctx.db
        .query("githubPullRequests")
        .withIndex("by_external_id", (q: any) => q.eq("externalId", externalId))
        .unique();
      const pullRequestPatch = {
        taskId: args.taskId,
        owner: args.owner,
        repo: args.repo,
        number: args.number,
        url: args.url,
        state: args.status,
        updatedAt: args.checkedAt,
        ...(args.headSha !== undefined ? { headSha: args.headSha } : {}),
        ...(args.headBranch !== undefined ? { headBranch: args.headBranch } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
      };
      if (existingPullRequest !== null) {
        await ctx.db.patch(existingPullRequest._id, pullRequestPatch);
      } else {
        await ctx.db.insert("githubPullRequests", {
          externalId,
          createdAt: args.checkedAt,
          ...pullRequestPatch,
        });
      }
    }

    const eventKind =
      args.status === "waiting_for_changes"
        ? "task-pr.waiting-for-changes"
        : args.status === "failed"
          ? "task-pr.failed"
          : "task-pr.created";
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: eventKind,
      summary:
        args.summary ??
        (args.status === "waiting_for_changes"
          ? "Task pull request is waiting for changes."
          : args.status === "failed"
            ? "Task pull request ensure failed."
            : "Task pull request is available."),
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        status: args.status,
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.number !== undefined ? { number: args.number } : {}),
        ...(args.headBranch !== undefined ? { headBranch: args.headBranch } : {}),
        ...(args.baseBranch !== undefined ? { baseBranch: args.baseBranch } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.draft !== undefined ? { draft: args.draft } : {}),
        ...(args.headSha !== undefined ? { headSha: args.headSha } : {}),
        ...(args.previewUrl !== undefined ? { previewUrl: args.previewUrl } : {}),
        ...(args.deploymentPreviewsJson !== undefined
          ? { deploymentPreviews: JSON.parse(args.deploymentPreviewsJson) }
          : {}),
      }),
      createdAt: args.checkedAt,
    });

    return null;
  },
});

export const recordTaskPullRequestsFromAssistantMessage = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    sourceEventId: v.string(),
    assistantMessage: v.string(),
    observedAt: v.number(),
  },
  returns: v.object({
    recorded: v.number(),
  }),
  handler: async (ctx, args) => {
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null || String(workSession.taskId) !== String(args.taskId)) {
      return { recorded: 0 };
    }

    const pullRequests = extractGitHubPullRequests(args.assistantMessage);
    let recorded = 0;
    for (const pullRequest of pullRequests) {
      const existingLink = await ctx.db
        .query("taskExternalLinks")
        .withIndex("by_kind_external_id", (q: any) =>
          q.eq("kind", "github_pr").eq("externalId", pullRequest.externalId),
        )
        .unique();
      if (existingLink !== null) {
        await ctx.db.patch(existingLink._id, {
          taskId: args.taskId,
          url: pullRequest.url,
          updatedAt: args.observedAt,
        });
      } else {
        await ctx.db.insert("taskExternalLinks", {
          taskId: args.taskId,
          kind: "github_pr",
          externalId: pullRequest.externalId,
          url: pullRequest.url,
          muted: false,
          createdAt: args.observedAt,
          updatedAt: args.observedAt,
        });
      }

      const existingPullRequest = await ctx.db
        .query("githubPullRequests")
        .withIndex("by_external_id", (q: any) => q.eq("externalId", pullRequest.externalId))
        .unique();
      const pullRequestPatch = {
        taskId: args.taskId,
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        number: pullRequest.number,
        url: pullRequest.url,
        state: "discovered",
        updatedAt: args.observedAt,
      };
      if (existingPullRequest !== null) {
        await ctx.db.patch(existingPullRequest._id, pullRequestPatch);
      } else {
        await ctx.db.insert("githubPullRequests", {
          externalId: pullRequest.externalId,
          createdAt: args.observedAt,
          ...pullRequestPatch,
        });
      }

      const eventKey = `${args.sourceEventId}:github-pr-discovered:${pullRequest.externalId}`;
      const existingEvent = await ctx.db
        .query("taskEvents")
        .withIndex("by_event_key", (q: any) => q.eq("eventKey", eventKey))
        .unique();
      if (existingEvent === null) {
        await ctx.db.insert("taskEvents", {
          taskId: args.taskId,
          eventKey,
          kind: "task-pr.discovered",
          summary: "Discovered task pull request from assistant response.",
          payloadJson: JSON.stringify({
            workSessionId: args.workSessionId,
            externalId: pullRequest.externalId,
            url: pullRequest.url,
          }),
          createdAt: args.observedAt,
        });
      }
      recorded += 1;
    }

    return { recorded };
  },
});

export const getTaskRuntimeAgentStartSeed = internalQuery({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
  },
  returns: v.union(
    v.null(),
    v.object({
      title: v.string(),
      taskThreadId: v.id("taskThreads"),
      worktreePath: v.optional(v.string()),
      runtimeProviderKind: v.optional(v.literal("local")),
      runtimeEndpointUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      return null;
    }
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null || String(workSession.taskId) !== String(args.taskId)) {
      return null;
    }
    const taskThread = await ctx.db.get(workSession.taskThreadId);
    if (taskThread === null) {
      return null;
    }

    return {
      title: task.title,
      taskThreadId: workSession.taskThreadId,
      ...(taskThread.worktreePath !== undefined ? { worktreePath: taskThread.worktreePath } : {}),
      ...(workSession.runtimeProviderKind !== undefined
        ? { runtimeProviderKind: workSession.runtimeProviderKind }
        : {}),
      ...(workSession.runtimeEndpointUrl !== undefined
        ? { runtimeEndpointUrl: workSession.runtimeEndpointUrl }
        : {}),
    };
  },
});

export const recordTaskRuntimeAgentStartRequested = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    eventKey: v.string(),
    requestedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: "runtime.agent-start-requested",
      summary: "T3 runtime coding agent start was requested.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
      }),
      createdAt: args.requestedAt,
    });
    return null;
  },
});

export const recordTaskRuntimeAgentStartAccepted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    eventKey: v.string(),
    acceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskThreadId, {
      t3ThreadId: args.t3ThreadId,
      updatedAt: args.acceptedAt,
    });
    await ctx.db.patch(args.workSessionId, {
      t3ThreadId: args.t3ThreadId,
      status: "accepted",
      updatedAt: args.acceptedAt,
    });
    await ctx.db.patch(args.taskId, {
      currentPrimaryTaskThreadId: args.taskThreadId,
      status: "working",
      updatedAt: args.acceptedAt,
    });

    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: args.eventKey,
        kind: "runtime.agent-start-accepted",
        summary: "T3 runtime coding agent start was accepted.",
        payloadJson: JSON.stringify({
          workSessionId: args.workSessionId,
          t3ThreadId: args.t3ThreadId,
        }),
        createdAt: args.acceptedAt,
      });
    }

    return null;
  },
});

export const recordTaskRuntimeAgentStartFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    eventKey: v.string(),
    failureSummary: v.string(),
    failedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.workSessionId, {
      status: "failed",
      failureSummary: args.failureSummary,
      updatedAt: args.failedAt,
      endedAt: args.failedAt,
    });
    await ctx.db.patch(args.taskId, {
      status: "failed",
      statusReason: args.failureSummary,
      updatedAt: args.failedAt,
    });

    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: args.eventKey,
        kind: "runtime.agent-start-failed",
        summary: "T3 runtime coding agent start failed.",
        payloadJson: JSON.stringify({
          workSessionId: args.workSessionId,
          failureSummary: args.failureSummary,
        }),
        createdAt: args.failedAt,
      });
    }

    return null;
  },
});

export const recordTaskRuntimeBranchObserved = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    branch: v.string(),
    eventKey: v.string(),
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null || String(workSession.taskId) !== String(args.taskId)) {
      return null;
    }

    const taskThread = await ctx.db.get(workSession.taskThreadId);
    if (taskThread === null || String(taskThread.taskId) !== String(args.taskId)) {
      return null;
    }

    await ctx.db.patch(workSession.taskThreadId, {
      branch: args.branch,
      updatedAt: args.observedAt,
    });

    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: args.eventKey,
        kind: "runtime.branch-observed",
        summary: "Observed current T3 runtime branch.",
        payloadJson: JSON.stringify({
          workSessionId: args.workSessionId,
          taskThreadId: workSession.taskThreadId,
          previousBranch: taskThread.branch,
          branch: args.branch,
        }),
        createdAt: args.observedAt,
      });
    }

    return null;
  },
});

export const getTaskRuntimeContinuationRoute = internalQuery({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
  },
  returns: v.object({
    runtimeProviderKind: v.optional(v.literal("local")),
    runtimeEndpointUrl: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null) {
      throw new Error(`Work Session ${args.workSessionId} does not exist`);
    }
    if (String(workSession.taskId) !== String(args.taskId)) {
      throw new Error(`Work Session ${args.workSessionId} does not belong to Task ${args.taskId}`);
    }
    if (workSession.t3ThreadId !== args.t3ThreadId) {
      throw new Error(
        `Work Session ${args.workSessionId} is attached to T3 Thread ${workSession.t3ThreadId}, not ${args.t3ThreadId}`,
      );
    }
    return {
      ...(workSession.runtimeProviderKind !== undefined
        ? { runtimeProviderKind: workSession.runtimeProviderKind }
        : {}),
      ...(workSession.runtimeEndpointUrl !== undefined
        ? { runtimeEndpointUrl: workSession.runtimeEndpointUrl }
        : {}),
    };
  },
});

export const recordTaskRuntimeContinuationAccepted = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    eventKey: v.string(),
    acceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent !== null) {
      return null;
    }

    await ctx.db.patch(args.workSessionId, {
      t3ThreadId: args.t3ThreadId,
      status: "accepted",
      updatedAt: args.acceptedAt,
    });
    await ctx.db.patch(args.taskId, {
      status: "working",
      updatedAt: args.acceptedAt,
    });
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventKey,
      kind: "runtime.continuation-accepted",
      summary: "T3 runtime continuation was accepted for the Task.",
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        t3ThreadId: args.t3ThreadId,
      }),
      createdAt: args.acceptedAt,
    });
    return null;
  },
});

export const prepareWorkSessionSeed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    startCodingAgent: v.boolean(),
  },
  returns: v.object({
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
  }),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (task === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const taskThreadId = await ctx.db.insert("taskThreads", {
      taskId: args.taskId,
      t3ThreadId: `pending:${crypto.randomUUID()}`,
      role: "primary",
      createdAt: now,
      updatedAt: now,
    });

    const workSessionId = await ctx.db.insert("workSessions", {
      taskId: args.taskId,
      taskThreadId,
      t3ThreadId: `pending:${String(taskThreadId)}`,
      status: "requested",
      updatedAt: now,
      bridgeRunId: String(taskThreadId),
      runtimeStatus: "requested",
      runtimeUpdatedAt: now,
    });

    await ctx.db.patch(args.taskId, {
      currentPrimaryTaskThreadId: taskThreadId,
      status:
        task.status === "ready" ? (args.startCodingAgent ? "working" : "needs_input") : task.status,
      updatedAt: now,
    });

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      kind: "runtime.materialization-requested",
      summary: "T3 runtime materialization was requested.",
      payloadJson: JSON.stringify({
        taskThreadId,
        workSessionId,
      }),
      createdAt: now,
    });

    return { taskThreadId, workSessionId };
  },
});

export const recordTaskRuntimeMaterialized = internalMutation({
  args: {
    taskId: v.id("tasks"),
    taskThreadId: v.id("taskThreads"),
    workSessionId: v.id("workSessions"),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    eventKey: v.string(),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    runtimeId: v.optional(v.string()),
    runtimeProviderKind: v.optional(v.literal("local")),
    runtimeExternalId: v.optional(v.string()),
    runtimeStatus: v.optional(
      v.union(
        v.literal("requested"),
        v.literal("queued"),
        v.literal("provisioning"),
        v.literal("starting"),
        v.literal("ready"),
        v.literal("running"),
        v.literal("idle"),
        v.literal("archiving"),
        v.literal("archived"),
        v.literal("failed"),
        v.literal("terminated"),
      ),
    ),
    environmentId: v.optional(v.string()),
    runtimeEndpointUrl: v.optional(v.string()),
    runtimeProviderRefJson: v.optional(v.string()),
    runtimeServicesJson: v.optional(v.string()),
    runtimeFailureSummary: v.optional(v.string()),
    acceptedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.taskThreadId, {
      t3ProjectId: args.t3ProjectId,
      t3ThreadId: args.t3ThreadId,
      updatedAt: args.acceptedAt,
      ...(args.branch !== undefined ? { branch: args.branch } : {}),
      ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
    });

    await ctx.db.patch(args.workSessionId, {
      t3ThreadId: args.t3ThreadId,
      status: "accepted",
      updatedAt: args.acceptedAt,
      ...(args.runtimeId !== undefined ? { runtimeId: args.runtimeId } : {}),
      ...(args.runtimeProviderKind !== undefined
        ? { runtimeProviderKind: args.runtimeProviderKind }
        : {}),
      ...(args.runtimeExternalId !== undefined
        ? { runtimeExternalId: args.runtimeExternalId }
        : {}),
      ...(args.runtimeStatus !== undefined ? { runtimeStatus: args.runtimeStatus } : {}),
      ...(args.environmentId !== undefined ? { environmentId: args.environmentId } : {}),
      ...(args.runtimeEndpointUrl !== undefined
        ? { runtimeEndpointUrl: args.runtimeEndpointUrl }
        : {}),
      ...(args.runtimeProviderRefJson !== undefined
        ? { runtimeProviderRefJson: args.runtimeProviderRefJson }
        : {}),
      ...(args.runtimeServicesJson !== undefined
        ? { runtimeServicesJson: args.runtimeServicesJson }
        : {}),
      ...(args.runtimeFailureSummary !== undefined
        ? { runtimeFailureSummary: args.runtimeFailureSummary }
        : {}),
      ...(args.runtimeStatus !== undefined || args.runtimeEndpointUrl !== undefined
        ? { runtimeUpdatedAt: args.acceptedAt }
        : {}),
    });

    const task = await ctx.db.get(args.taskId);
    if (task !== null) {
      await ctx.db.patch(args.taskId, {
        currentPrimaryTaskThreadId: args.taskThreadId,
        updatedAt: args.acceptedAt,
      });
    }

    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: args.eventKey,
        kind: "runtime.materialized",
        summary: "T3 runtime was materialized for the Task.",
        payloadJson: JSON.stringify({
          taskThreadId: args.taskThreadId,
          workSessionId: args.workSessionId,
          t3ProjectId: args.t3ProjectId,
          t3ThreadId: args.t3ThreadId,
          ...(args.branch !== undefined ? { branch: args.branch } : {}),
          ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
          ...(args.runtimeId !== undefined ? { runtimeId: args.runtimeId } : {}),
          ...(args.runtimeProviderKind !== undefined
            ? { runtimeProviderKind: args.runtimeProviderKind }
            : {}),
          ...(args.runtimeStatus !== undefined ? { runtimeStatus: args.runtimeStatus } : {}),
          ...(args.runtimeEndpointUrl !== undefined
            ? { runtimeEndpointUrl: args.runtimeEndpointUrl }
            : {}),
        }),
        createdAt: args.acceptedAt,
      });
    }

    return null;
  },
});

export const recordTaskRuntimeMaterializationFailed = internalMutation({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    eventKey: v.string(),
    failureSummary: v.string(),
    failedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.workSessionId, {
      status: "failed",
      failureSummary: args.failureSummary,
      runtimeStatus: "failed",
      runtimeFailureSummary: args.failureSummary,
      runtimeUpdatedAt: args.failedAt,
      endedAt: args.failedAt,
      updatedAt: args.failedAt,
    });
    await ctx.db.patch(args.taskId, {
      status: "failed",
      statusReason: args.failureSummary,
      updatedAt: args.failedAt,
    });

    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventKey))
      .unique();
    if (existingEvent === null) {
      await ctx.db.insert("taskEvents", {
        taskId: args.taskId,
        eventKey: args.eventKey,
        kind: "runtime.materialization-failed",
        summary: "T3 runtime materialization failed.",
        payloadJson: JSON.stringify({
          workSessionId: args.workSessionId,
          failureSummary: args.failureSummary,
        }),
        createdAt: args.failedAt,
      });
    }

    return null;
  },
});

export const applyTaskRuntimeLifecycleEvent = internalMutation({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    type: v.union(
      v.literal("started"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("interrupted"),
    ),
    occurredAt: v.string(),
    t3ThreadId: v.optional(v.string()),
    t3TurnId: v.optional(v.string()),
    failureSummary: v.optional(v.string()),
    assistantResponse: v.optional(v.string()),
  },
  returns: v.object({
    applied: v.boolean(),
    status: v.union(
      v.literal("requested"),
      v.literal("accepted"),
      v.literal("started"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("interrupted"),
      v.literal("superseded"),
    ),
  }),
  handler: async (ctx, args) => {
    const existingEvent = await ctx.db
      .query("taskEvents")
      .withIndex("by_event_key", (q: any) => q.eq("eventKey", args.eventId))
      .unique();
    const workSession = await ctx.db.get(args.workSessionId);
    if (workSession === null) {
      throw new Error(`Work Session ${args.workSessionId} does not exist`);
    }
    if (String(workSession.taskId) !== String(args.taskId)) {
      throw new Error(`Work Session ${args.workSessionId} does not belong to Task ${args.taskId}`);
    }
    if (existingEvent !== null) {
      return { applied: false, status: workSession.status };
    }

    const occurredAtMs = Date.parse(args.occurredAt);
    const nextStatus = args.type;
    const ended =
      args.type === "completed" || args.type === "failed" || args.type === "interrupted";

    await ctx.db.patch(args.workSessionId, {
      status: nextStatus,
      updatedAt: occurredAtMs,
      ...(args.type === "started" && workSession.startedAt === undefined
        ? { startedAt: occurredAtMs }
        : {}),
      ...(ended ? { endedAt: occurredAtMs } : {}),
      ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
      ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
      ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
      ...(args.assistantResponse !== undefined
        ? { assistantResponse: args.assistantResponse }
        : {}),
    });

    if (args.type === "failed") {
      await ctx.db.patch(args.taskId, {
        status: "failed",
        statusReason: args.failureSummary ?? "Coding Agent work failed.",
        updatedAt: occurredAtMs,
      });
    }

    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      eventKey: args.eventId,
      kind: `work-session.${args.type}`,
      summary: `Work Session ${args.type}.`,
      payloadJson: JSON.stringify({
        workSessionId: args.workSessionId,
        ...(args.t3ThreadId !== undefined ? { t3ThreadId: args.t3ThreadId } : {}),
        ...(args.t3TurnId !== undefined ? { t3TurnId: args.t3TurnId } : {}),
        ...(args.failureSummary !== undefined ? { failureSummary: args.failureSummary } : {}),
        ...(args.assistantResponse !== undefined
          ? { assistantResponse: args.assistantResponse }
          : {}),
      }),
      createdAt: occurredAtMs,
    });

    return { applied: true, status: nextStatus };
  },
});
