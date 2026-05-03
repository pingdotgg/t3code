import { v } from "convex/values";
import { Schema } from "effect";
import {
  ProviderInstanceId,
  SandboxId,
  ThreadId,
  type ModelSelection,
  type TaskRuntimeMaterializeResponse,
} from "@t3tools/contracts";

import { createT3ExecutionBridgeClient } from "../src/t3/client.ts";
import {
  extractT3RuntimeEndpoint,
  resolveTaskRuntimeBridgeBaseUrl,
} from "../src/t3/runtimeRouting.ts";
import { internal, api } from "./_generated/api.js";
import { action, internalMutation, internalQuery } from "./_generated/server.js";

function parseAllowedSecretNames(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const modalCodingAgentModelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "amazon-bedrock/us.anthropic.claude-opus-4-7",
};

export const materializeTaskRuntime = action({
  args: {
    taskId: v.id("tasks"),
    initialPrompt: v.string(),
    startCodingAgent: v.optional(v.boolean()),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ProjectId: v.string(),
    t3ThreadId: v.string(),
    branch: v.union(v.null(), v.string()),
    worktreePath: v.union(v.null(), v.string()),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const tree = await ctx.runQuery(api.tasks.getTaskRuntimeSeed, {
      taskId: args.taskId,
    });
    if (tree === null) {
      throw new Error(`Task ${args.taskId} does not exist`);
    }

    const providerKind = tree.project.sandboxProvider ?? "local";
    const requestedStartCodingAgent = args.startCodingAgent ?? true;
    const startCodingAgentAfterMaterialization =
      providerKind === "modal" && requestedStartCodingAgent;
    const workSessionSeed = await ctx.runMutation(internal.t3Runtime.prepareWorkSessionSeed, {
      taskId: args.taskId,
      startCodingAgent: requestedStartCodingAgent,
      sandboxProviderKind: providerKind,
    });

    const client = createT3ExecutionBridgeClient();
    const resources = {
      ...(tree.project.modalCpu !== undefined ? { cpu: tree.project.modalCpu } : {}),
      ...(tree.project.modalCpuLimit !== undefined ? { cpuLimit: tree.project.modalCpuLimit } : {}),
      ...(tree.project.modalMemoryMiB !== undefined
        ? { memoryMiB: tree.project.modalMemoryMiB }
        : {}),
      ...(tree.project.modalMemoryLimitMiB !== undefined
        ? { memoryLimitMiB: tree.project.modalMemoryLimitMiB }
        : {}),
      ...(tree.project.modalTimeoutMs !== undefined
        ? { timeoutMs: tree.project.modalTimeoutMs }
        : {}),
      ...(tree.project.modalIdleTimeoutMs !== undefined
        ? { idleTimeoutMs: tree.project.modalIdleTimeoutMs }
        : {}),
    };
    const allowedSecretNames = parseAllowedSecretNames(tree.project.modalAllowedSecretNamesJson);
    const providerConfig = {
      ...(tree.project.modalAppName !== undefined ? { appName: tree.project.modalAppName } : {}),
      ...(tree.project.modalImageTag !== undefined ? { imageTag: tree.project.modalImageTag } : {}),
      ...(allowedSecretNames !== undefined ? { allowedSecretNames } : {}),
    };
    const idempotencyKey = `sandbox:${providerKind}:${String(args.taskId)}:${String(workSessionSeed.workSessionId)}`;

    let response: TaskRuntimeMaterializeResponse;
    try {
      response = await client.materializeTaskRuntime({
        taskId: String(args.taskId),
        workSessionId: String(workSessionSeed.workSessionId),
        initialPrompt: args.initialPrompt,
        title: tree.task.title,
        runtimeMode: "full-access",
        interactionMode: "default",
        startCodingAgent: startCodingAgentAfterMaterialization ? false : requestedStartCodingAgent,
        sandbox: {
          providerKind,
          ...(Object.keys(resources).length > 0 ? { resources } : {}),
          ...(tree.project.modalEnvironment !== undefined
            ? { environment: tree.project.modalEnvironment }
            : {}),
          ...(Object.keys(providerConfig).length > 0 ? { providerConfig } : {}),
        },
        services: [
          {
            kind: "t3-runtime",
            required: true,
          },
        ],
        idempotencyKey,
        project: {
          repoName: tree.project.repoName,
          workspaceRoot: tree.project.sandboxWorkspaceRoot,
          defaultBranch: tree.project.defaultBranch,
        },
      });
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeMaterializationFailed, {
        taskId: args.taskId,
        workSessionId: workSessionSeed.workSessionId,
        eventKey: `${idempotencyKey}:failed`,
        failureSummary,
        failedAt: Date.now(),
      });
      throw error;
    }

    const services = response.services ?? response.sandbox?.services;
    const runtimeEndpointUrl = extractT3RuntimeEndpoint(services);

    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeMaterialized, {
      taskId: args.taskId,
      taskThreadId: workSessionSeed.taskThreadId,
      workSessionId: workSessionSeed.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
      eventKey: `${idempotencyKey}:materialized`,
      acceptedAt: Date.parse(response.acceptedAt),
      ...(response.branch !== null
        ? { branch: response.branch }
        : response.sandbox?.worktree?.branch !== undefined
          ? { branch: response.sandbox.worktree.branch }
          : {}),
      ...(response.worktreePath !== null
        ? { worktreePath: response.worktreePath }
        : response.sandbox?.worktree?.worktreePath !== undefined
          ? { worktreePath: response.sandbox.worktree.worktreePath }
          : {}),
      ...(response.sandbox !== undefined
        ? {
            sandboxId: String(response.sandbox.sandboxId),
            sandboxProviderKind: response.sandbox.providerKind,
            sandboxExternalId: response.sandbox.providerRef.externalId,
            sandboxStatus: response.sandbox.status,
            ...(response.sandbox.environment !== undefined
              ? { sandboxEnvironmentId: response.sandbox.environment }
              : {}),
            sandboxProviderRefJson: JSON.stringify(response.sandbox.providerRef),
            ...(response.sandbox.failure !== undefined
              ? { sandboxFailureSummary: response.sandbox.failure.message }
              : {}),
          }
        : { sandboxProviderKind: providerKind }),
      ...(runtimeEndpointUrl !== undefined
        ? { sandboxRuntimeEndpointUrl: runtimeEndpointUrl }
        : {}),
      ...(services !== undefined ? { sandboxServicesJson: JSON.stringify(services) } : {}),
    });

    if (!startCodingAgentAfterMaterialization) {
      await ctx.scheduler.runAfter(0, api.t3Runtime.ensureTaskPullRequest, {
        taskId: args.taskId,
        workSessionId: workSessionSeed.workSessionId,
        reason: "runtime-materialized",
      });
    }
    if (startCodingAgentAfterMaterialization) {
      await ctx.scheduler.runAfter(15_000, api.t3Runtime.startMaterializedTaskRuntimeAgent, {
        taskId: args.taskId,
        workSessionId: workSessionSeed.workSessionId,
        initialPrompt: args.initialPrompt,
      });
    }

    return {
      taskId: response.taskId,
      workSessionId: response.workSessionId,
      t3ProjectId: String(response.t3ProjectId),
      t3ThreadId: String(response.t3ThreadId),
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
  handler: async (ctx, args) => {
    const seed = await ctx.runQuery(internal.t3Runtime.getTaskRuntimeAgentStartSeed, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
    });
    if (seed === null) {
      return { started: false, skippedReason: "Task runtime is not materialized yet." };
    }
    if (seed.sandboxRuntimeEndpointUrl === undefined) {
      return { started: false, skippedReason: "Task runtime does not have a sandbox endpoint." };
    }
    if (seed.worktreePath === undefined) {
      return { started: false, skippedReason: "Task runtime does not have a worktree path." };
    }

    const eventKey = `task-runtime-agent:start:${String(args.taskId)}:${String(args.workSessionId)}`;
    await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeAgentStartRequested, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      eventKey: `${eventKey}:requested`,
      requestedAt: Date.now(),
    });

    const client = createT3ExecutionBridgeClient({
      baseUrl: resolveTaskRuntimeBridgeBaseUrl({
        providerKind: seed.sandboxProviderKind,
        runtimeEndpointUrl: seed.sandboxRuntimeEndpointUrl,
      }),
    });

    try {
      const response = await client.createExecutionRun({
        controlThreadId: String(args.taskId),
        executionRunId: String(args.workSessionId),
        initialPrompt: args.initialPrompt,
        workspaceRoot: seed.worktreePath,
        title: seed.title,
        modelSelection: modalCodingAgentModelSelection,
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

      return {
        started: true,
        t3ThreadId: String(response.t3ThreadId),
        acceptedAt: response.acceptedAt,
      };
    } catch (error) {
      const failureSummary = error instanceof Error ? error.message : String(error);
      await ctx.runMutation(internal.t3Runtime.recordTaskRuntimeAgentStartFailed, {
        taskId: args.taskId,
        workSessionId: args.workSessionId,
        eventKey: `${eventKey}:failed`,
        failureSummary,
        failedAt: Date.now(),
      });
      throw error;
    }
  },
});

export const continueTaskRuntime = action({
  args: {
    eventId: v.string(),
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
    prompt: v.string(),
  },
  returns: v.object({
    taskId: v.string(),
    workSessionId: v.string(),
    t3ThreadId: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const route = await ctx.runQuery(internal.t3Runtime.getTaskRuntimeContinuationRoute, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      t3ThreadId: args.t3ThreadId,
    });

    const client = createT3ExecutionBridgeClient({
      baseUrl: resolveTaskRuntimeBridgeBaseUrl({
        providerKind: route.sandboxProviderKind,
        runtimeEndpointUrl: route.sandboxRuntimeEndpointUrl,
      }),
    });
    const t3ThreadId = Schema.decodeUnknownSync(ThreadId)(args.t3ThreadId);
    const response = await client.continueExecutionRun({
      controlThreadId: String(args.taskId),
      executionRunId: String(args.workSessionId),
      t3ThreadId,
      prompt: args.prompt,
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

    await ctx.scheduler.runAfter(0, api.t3Runtime.ensureTaskPullRequest, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      reason: "runtime-continuation",
    });

    return {
      taskId: String(args.taskId),
      workSessionId: String(response.executionRunId),
      t3ThreadId: String(response.t3ThreadId),
      acceptedAt: response.acceptedAt,
    };
  },
});

export const ensureTaskPullRequest = action({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    status: v.union(
      v.literal("waiting_for_changes"),
      v.literal("created"),
      v.literal("existing"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    url: v.optional(v.string()),
    summary: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const seed = await ctx.runQuery(internal.t3Runtime.getTaskPullRequestSeed, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
    });
    if (seed === null) {
      return { status: "skipped" as const, summary: "Task runtime is not materialized yet." };
    }

    const idempotencyKey = `task-pr:${String(args.taskId)}:${String(args.workSessionId)}:${seed.branch}`;
    await ctx.runMutation(internal.t3Runtime.recordTaskPullRequestRequested, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      eventKey: `${idempotencyKey}:requested`,
      reason: args.reason ?? "unspecified",
    });

    const client = createT3ExecutionBridgeClient({
      baseUrl: resolveTaskRuntimeBridgeBaseUrl({
        providerKind: seed.sandboxProviderKind,
        runtimeEndpointUrl: seed.sandboxRuntimeEndpointUrl,
      }),
    });
    const sandboxId =
      seed.sandboxId !== undefined
        ? Schema.decodeUnknownSync(SandboxId)(seed.sandboxId)
        : undefined;
    const response = await client.ensureTaskPullRequest({
      taskId: String(args.taskId),
      workSessionId: String(args.workSessionId),
      ...(sandboxId !== undefined ? { sandboxId } : {}),
      ...(seed.sandboxEnvironmentId !== undefined
        ? { environmentId: seed.sandboxEnvironmentId }
        : {}),
      branch: seed.branch,
      worktreePath: seed.worktreePath,
      title: seed.title,
      idempotencyKey,
      project: {
        githubOwner: seed.project.githubOwner,
        githubRepo: seed.project.githubRepo,
        defaultBranch: seed.project.defaultBranch,
      },
    });

    await ctx.runMutation(internal.t3Runtime.recordTaskPullRequestEnsureResult, {
      taskId: args.taskId,
      workSessionId: args.workSessionId,
      eventKey: `${idempotencyKey}:${response.status}`,
      status: response.status,
      checkedAt: Date.parse(response.checkedAt),
      ...(response.summary !== undefined ? { summary: response.summary } : {}),
      ...(response.pullRequest !== undefined
        ? {
            owner: response.pullRequest.owner,
            repo: response.pullRequest.repo,
            number: response.pullRequest.number,
            url: response.pullRequest.url,
            headBranch: response.pullRequest.headBranch,
            baseBranch: response.pullRequest.baseBranch,
            title: response.pullRequest.title,
            draft: response.pullRequest.draft,
          }
        : {}),
    });

    return {
      status: response.status,
      ...(response.pullRequest !== undefined ? { url: response.pullRequest.url } : {}),
      ...(response.summary !== undefined ? { summary: response.summary } : {}),
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
      branch: v.string(),
      worktreePath: v.string(),
      sandboxId: v.optional(v.string()),
      sandboxProviderKind: v.optional(v.union(v.literal("local"), v.literal("modal"))),
      sandboxEnvironmentId: v.optional(v.string()),
      sandboxRuntimeEndpointUrl: v.optional(v.string()),
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
      branch: taskThread.branch,
      worktreePath: taskThread.worktreePath,
      ...(workSession.sandboxId !== undefined ? { sandboxId: workSession.sandboxId } : {}),
      ...(workSession.sandboxProviderKind !== undefined
        ? { sandboxProviderKind: workSession.sandboxProviderKind }
        : {}),
      ...(workSession.sandboxEnvironmentId !== undefined
        ? { sandboxEnvironmentId: workSession.sandboxEnvironmentId }
        : {}),
      ...(workSession.sandboxRuntimeEndpointUrl !== undefined
        ? { sandboxRuntimeEndpointUrl: workSession.sandboxRuntimeEndpointUrl }
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
      createdAt: Date.now(),
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
      }),
      createdAt: args.checkedAt,
    });

    return null;
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
      sandboxProviderKind: v.optional(v.union(v.literal("local"), v.literal("modal"))),
      sandboxRuntimeEndpointUrl: v.optional(v.string()),
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
      ...(workSession.sandboxProviderKind !== undefined
        ? { sandboxProviderKind: workSession.sandboxProviderKind }
        : {}),
      ...(workSession.sandboxRuntimeEndpointUrl !== undefined
        ? { sandboxRuntimeEndpointUrl: workSession.sandboxRuntimeEndpointUrl }
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

export const getTaskRuntimeContinuationRoute = internalQuery({
  args: {
    taskId: v.id("tasks"),
    workSessionId: v.id("workSessions"),
    t3ThreadId: v.string(),
  },
  returns: v.object({
    sandboxProviderKind: v.optional(v.union(v.literal("local"), v.literal("modal"))),
    sandboxRuntimeEndpointUrl: v.optional(v.string()),
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
      ...(workSession.sandboxProviderKind !== undefined
        ? { sandboxProviderKind: workSession.sandboxProviderKind }
        : {}),
      ...(workSession.sandboxRuntimeEndpointUrl !== undefined
        ? { sandboxRuntimeEndpointUrl: workSession.sandboxRuntimeEndpointUrl }
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
    sandboxProviderKind: v.union(v.literal("local"), v.literal("modal")),
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

    const now = Date.now();
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
      sandboxProviderKind: args.sandboxProviderKind,
      sandboxStatus: "requested",
      sandboxUpdatedAt: now,
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
        sandboxProviderKind: args.sandboxProviderKind,
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
    sandboxId: v.optional(v.string()),
    sandboxProviderKind: v.optional(v.union(v.literal("local"), v.literal("modal"))),
    sandboxExternalId: v.optional(v.string()),
    sandboxStatus: v.optional(
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
    sandboxEnvironmentId: v.optional(v.string()),
    sandboxRuntimeEndpointUrl: v.optional(v.string()),
    sandboxProviderRefJson: v.optional(v.string()),
    sandboxServicesJson: v.optional(v.string()),
    sandboxFailureSummary: v.optional(v.string()),
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
      ...(args.sandboxId !== undefined ? { sandboxId: args.sandboxId } : {}),
      ...(args.sandboxProviderKind !== undefined
        ? { sandboxProviderKind: args.sandboxProviderKind }
        : {}),
      ...(args.sandboxExternalId !== undefined
        ? { sandboxExternalId: args.sandboxExternalId }
        : {}),
      ...(args.sandboxStatus !== undefined ? { sandboxStatus: args.sandboxStatus } : {}),
      ...(args.sandboxEnvironmentId !== undefined
        ? { sandboxEnvironmentId: args.sandboxEnvironmentId }
        : {}),
      ...(args.sandboxRuntimeEndpointUrl !== undefined
        ? { sandboxRuntimeEndpointUrl: args.sandboxRuntimeEndpointUrl }
        : {}),
      ...(args.sandboxProviderRefJson !== undefined
        ? { sandboxProviderRefJson: args.sandboxProviderRefJson }
        : {}),
      ...(args.sandboxServicesJson !== undefined
        ? { sandboxServicesJson: args.sandboxServicesJson }
        : {}),
      ...(args.sandboxFailureSummary !== undefined
        ? { sandboxFailureSummary: args.sandboxFailureSummary }
        : {}),
      ...(args.sandboxStatus !== undefined || args.sandboxRuntimeEndpointUrl !== undefined
        ? { sandboxUpdatedAt: args.acceptedAt }
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
          ...(args.sandboxId !== undefined ? { sandboxId: args.sandboxId } : {}),
          ...(args.sandboxProviderKind !== undefined
            ? { sandboxProviderKind: args.sandboxProviderKind }
            : {}),
          ...(args.sandboxStatus !== undefined ? { sandboxStatus: args.sandboxStatus } : {}),
          ...(args.sandboxRuntimeEndpointUrl !== undefined
            ? { sandboxRuntimeEndpointUrl: args.sandboxRuntimeEndpointUrl }
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
      sandboxStatus: "failed",
      sandboxFailureSummary: args.failureSummary,
      sandboxUpdatedAt: args.failedAt,
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
      }),
      createdAt: occurredAtMs,
    });

    return { applied: true, status: nextStatus };
  },
});
