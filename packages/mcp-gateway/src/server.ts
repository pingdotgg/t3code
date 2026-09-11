import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import { z } from "zod";

import { GatewayError, type GatewayRuntimePort } from "./port.ts";
import {
  callGatewayTool,
  handoffInputSchema,
  type GatewayGrantSource,
  type GatewayProfileSource,
  type GatewayToolContext,
} from "./tools.ts";

const environmentId = z.string().trim().min(1);
const threadId = z.string().trim().min(1);
const idempotencyKey = z.string().trim().min(1).max(200);
const optionalRequestContext = {
  requestId: z.string().trim().min(1).max(200).optional(),
  correlationId: z.string().trim().min(1).max(200).optional(),
};
const page = {
  afterSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
const pr = {
  environmentId,
  projectId: z.string().trim().min(1),
  repository: z.string().trim().min(1),
  number: z.number().int().min(1),
};
const webhook = { environmentId, webhookId: z.string().trim().min(1) };

const profileFields = {
  name: z.string().trim().min(1).max(200),
  providerLabel: z.string().trim().min(1),
  modelLabel: z.string().trim().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z
    .enum(["orb", "bot", "code", "pen", "search", "shield", "sparkles", "terminal"])
    .optional(),
  systemPrompt: z.string().max(32_000).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
  runtimeMode: z.enum([
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
    "read-only",
  ]),
  interactionMode: z.enum(["default", "plan"]),
  environmentIds: z.array(z.string().trim().min(1)).optional(),
};

type ToolSpec = readonly [description: string, inputSchema: z.ZodRawShape];

const TOOL_SPECS = {
  t3_list_agents: [
    "List agents from the shared Agents library available on this environment, including instructions and model settings. Use profileId to create chats or hand work to an agent.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_create_agent: [
    "Create an agent in the shared Agents library without starting a session. Requires create or admin access. Shares to connected machines with the same grant.",
    { environmentId, ...profileFields },
  ],
  t3_update_agent: [
    "Update an agent by profileId. New threads use the new revision; existing threads stay unchanged.",
    {
      environmentId,
      profileId: z.string().trim().min(1),
      patch: z.object(profileFields).partial().strict(),
    },
  ],
  t3_delete_agent: [
    "Remove an agent from the shared Agents library, retaining its chats.",
    { environmentId, profileId: z.string().trim().min(1) },
  ],
  t3_handoff_thread: [
    "Hand work to a new agent chat: save a Markdown brief with a reviewed summary and selected source file contents, then send the destination task. Use a stable handoffId UUID for retries. Source conversation remains intact. After success ASK the user whether to settle it; never infer approval. A created status means delivery failed: open the returned thread to recover rather than making another chat.",
    handoffInputSchema.shape,
  ],
  t3_settle_thread: [
    "Settle a conversation only after the user explicitly chooses to settle it. Requires lifecycle scope. Does not delete the conversation. Do not call automatically after a handoff.",
    { environmentId, threadId, confirmed: z.literal(true) },
  ],
  t3_unsettle_thread: [
    "Return a settled chat to active work in its agent column. Requires lifecycle scope. Does not send a message or start a turn.",
    { environmentId, threadId },
  ],
  t3_open_agents: [
    "Open the Agents board in the connected desktop app and reveal its window.",
    { environmentId },
  ],
  t3_list_environments: ["List T3 environments granted to this host.", optionalRequestContext],
  t3_get_environment_status: [
    "Get connection state for one T3 environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_environment_health: [
    "Get authoritative runtime health for one environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_gateway_health: [
    "Get MCP, bridge, event retention, and delivery queue health.",
    optionalRequestContext,
  ],
  t3_list_projects: [
    "List projects in one T3 environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_list_threads: [
    "List chats in one T3 environment, optionally filtered by agent profileId, project, and active/settled state.",
    {
      environmentId,
      state: z.enum(["all", "active", "settled"]).optional(),
      projectId: z.string().trim().min(1).optional(),
      profileId: z.string().trim().min(1).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_open_thread: [
    "Open a local or remote chat in the connected desktop app and reveal its window. Requires read access; does not start or stop a turn.",
    { environmentId, threadId },
  ],
  t3_get_thread: [
    "Read one T3 chat and its messages.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_summarize_thread: [
    "Summarize authoritative thread state and the next action.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_get_messages: [
    "Read recent messages from one T3 chat.",
    {
      environmentId,
      threadId,
      limit: z.number().int().min(1).max(100).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_get_thread_history: [
    "Read replayable progress events after a sequence cursor.",
    { environmentId, threadId, ...page, ...optionalRequestContext },
  ],
  t3_get_operation_history: [
    "Read durable operation events after a sequence cursor.",
    { environmentId, threadId: threadId.optional(), ...page, ...optionalRequestContext },
  ],
  t3_list_artifacts: [
    "List durable artifacts for one chat.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_get_artifact: [
    "Get a short-lived URL for one authorized artifact.",
    {
      environmentId,
      threadId,
      artifactId: z.string().trim().min(1),
      ...optionalRequestContext,
    },
  ],
  t3_create_thread: [
    "Create a chat with an immutable resolved profile snapshot. For agent tasks, pass profileId from t3_list_agents to snapshot that agent’s instructions and settings. Then use t3_send_message to start work.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      title: z.string().trim().min(1),
      profile: z.string().trim().min(1).optional(),
      profileId: z.string().trim().min(1).optional(),
      reasoningEffort: z.string().trim().min(1).optional(),
      modelSelection: z
        .object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1) })
        .strict()
        .optional(),
      runtimeMode: z
        .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
        .optional(),
      interactionMode: z.enum(["default", "plan"]).optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_send_message: [
    "Send a user message to an existing T3 chat.",
    {
      environmentId,
      threadId,
      text: z.string().trim().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_control_thread: [
    "Cancel, stop, pause, resume, retry, or restart a T3 chat.",
    {
      environmentId,
      threadId,
      action: z.enum(["cancel", "stop", "pause", "resume", "retry", "restart"]),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_stop_thread: [
    "Request stopping the thread provider session. Requires control or lifecycle scope. Accepted is not confirmed stopped: verify session status with t3_get_thread. Does not remove queued messages.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_cancel_thread: [
    "Cancel queued or running thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_pause_thread: [
    "Request interruption of active thread work. Requires control or lifecycle scope. Accepted is not confirmed paused: read the thread until its turn/session is no longer running. Does not pause queued messages or suspend a provider process.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_resume_thread: [
    "Resume paused or interrupted thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_retry_thread: [
    "Retry failed or interrupted thread work.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_restart_thread: [
    "Start a fresh execution attempt without erasing history.",
    {
      environmentId,
      threadId,
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_respond_to_approval: [
    "Approve or reject one pending T3 action.",
    {
      environmentId,
      threadId,
      approvalRequestId: z.string().trim().min(1),
      decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      confirmDestructive: z.boolean().optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_get_approval_plan: [
    "Read the current grouped approval plan.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_approve_actions: [
    "Atomically approve selected actions from one plan revision.",
    {
      environmentId,
      threadId,
      actionIds: z.array(z.string().trim().min(1)).min(1),
      planRevision: z.number().int().min(0),
      confirmDestructive: z.boolean().optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_reject_actions: [
    "Atomically reject selected actions from one plan revision.",
    {
      environmentId,
      threadId,
      actionIds: z.array(z.string().trim().min(1)).min(1),
      planRevision: z.number().int().min(0),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_modify_actions: [
    "Modify allowed fields on selected approval actions.",
    {
      environmentId,
      threadId,
      modifications: z
        .array(
          z
            .object({
              actionId: z.string().trim().min(1),
              fields: z.record(z.string(), z.unknown()),
            })
            .strict(),
        )
        .min(1),
      planRevision: z.number().int().min(0),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_subscribe_events: [
    "Create a durable replay-then-live MCP event subscription.",
    {
      environmentId,
      types: z.array(z.string().trim().min(1)).optional(),
      afterSequence: z.number().int().min(0).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_get_events: [
    "Replay retained environment events after a sequence cursor.",
    {
      environmentId,
      types: z.array(z.string().trim().min(1)).optional(),
      ...page,
      ...optionalRequestContext,
    },
  ],
  t3_replay_events: [
    "Replay retained events for a durable subscription.",
    {
      environmentId,
      subscriptionId: z.string().trim().min(1),
      limit: z.number().int().min(1).max(500).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_ack_events: [
    "Acknowledge processed events monotonically.",
    {
      environmentId,
      subscriptionId: z.string().trim().min(1),
      throughSequence: z.number().int().min(0),
      ...optionalRequestContext,
    },
  ],
  t3_register_webhook: [
    "Register an HTTPS webhook; return its signing secret once.",
    {
      environmentId,
      url: z.string().trim().url(),
      types: z.array(z.string().trim().min(1)).optional(),
      ...optionalRequestContext,
    },
  ],
  t3_update_webhook: [
    "Update an existing webhook event filter.",
    { ...webhook, types: z.array(z.string().trim().min(1)).optional(), ...optionalRequestContext },
  ],
  t3_rotate_webhook_secret: [
    "Rotate a webhook secret without moving its cursor.",
    { ...webhook, ...optionalRequestContext },
  ],
  t3_delete_webhook: ["Delete an existing webhook.", { ...webhook, ...optionalRequestContext }],
  t3_list_webhooks: [
    "List registered webhooks for one environment.",
    { environmentId, ...optionalRequestContext },
  ],
  t3_get_pr: ["Read pull request state.", { ...pr, ...optionalRequestContext }],
  t3_get_pr_checks: ["Read pull request checks.", { ...pr, ...optionalRequestContext }],
  t3_list_review_comments: [
    "List unresolved pull request review threads.",
    { ...pr, ...optionalRequestContext },
  ],
  t3_git_status: [
    "Read repository working tree and branch status.",
    { environmentId, projectId: z.string().trim().min(1), ...optionalRequestContext },
  ],
  t3_get_diff: [
    "Read the bounded thread diff.",
    { environmentId, threadId, ...optionalRequestContext },
  ],
  t3_apply_patch: [
    "Apply a patch through the authoritative T3 runtime.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      patch: z.string().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_create_branch: [
    "Create a repository branch.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      branch: z.string().trim().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_commit_changes: [
    "Commit selected repository changes.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      message: z.string().trim().min(1),
      paths: z.array(z.string().trim().min(1)).optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_create_pr: [
    "Create a fork pull request, draft by default.",
    {
      environmentId,
      projectId: z.string().trim().min(1),
      repository: z.string().trim().min(1),
      owner: z.string().trim().min(1),
      headBranch: z.string().trim().min(1),
      baseBranch: z.string().trim().min(1),
      title: z.string().trim().min(1),
      body: z.string().optional(),
      draft: z.boolean().default(true),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_update_pr: [
    "Update pull request title or body.",
    {
      ...pr,
      title: z.string().trim().min(1).optional(),
      body: z.string().optional(),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_reply_review_comment: [
    "Reply to a pull request review thread.",
    {
      ...pr,
      commentId: z.string().trim().min(1),
      body: z.string().min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_apply_review_fixes: [
    "Apply approved review fixes while preserving unresolved state until refresh.",
    {
      environmentId,
      threadId,
      projectId: z.string().trim().min(1),
      repository: z.string().trim().min(1),
      number: z.number().int().min(1),
      commentIds: z.array(z.string().trim().min(1)).min(1),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
  t3_publish_pr: [
    "Publish a draft pull request with destructive confirmation.",
    {
      ...pr,
      confirmDestructive: z.literal(true),
      idempotencyKey,
      correlationId: optionalRequestContext.correlationId,
    },
  ],
} satisfies Record<string, ToolSpec>;

const LIFECYCLE_ALIASES: Readonly<Record<string, string>> = {
  t3_stop_thread: "stop",
  t3_cancel_thread: "cancel",
  t3_pause_thread: "pause",
  t3_resume_thread: "resume",
  t3_retry_thread: "retry",
  t3_restart_thread: "restart",
};

function requestContext(args: Record<string, unknown>) {
  return {
    requestId:
      typeof args.requestId === "string"
        ? args.requestId
        : typeof args.idempotencyKey === "string"
          ? args.idempotencyKey
          : `req_${NodeCrypto.randomUUID()}`,
    correlationId:
      typeof args.correlationId === "string"
        ? args.correlationId
        : `corr_${NodeCrypto.randomUUID()}`,
  };
}

function success(value: unknown, context: ReturnType<typeof requestContext>) {
  const body = {
    schemaVersion: "3",
    ...context,
    serverTime: DateTime.formatIso(DateTime.nowUnsafe()),
    data: value,
    warnings: [] as ReadonlyArray<string>,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function failure(error: unknown, context: ReturnType<typeof requestContext>) {
  const detail: Record<string, unknown> =
    error instanceof GatewayError
      ? error.toJSON()
      : {
          code: "upstream_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
  const body = {
    schemaVersion: "3",
    error: {
      ...detail,
      requestId: typeof detail.requestId === "string" ? detail.requestId : context.requestId,
      correlationId: context.correlationId,
    },
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

export function createMcpGateway(input: {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly repositoryAllowlist?: ReadonlyArray<string>;
  readonly events?: import("./events.ts").GatewayEventStore;
  readonly health?: GatewayToolContext["health"];
}) {
  const server = new McpServer({ name: "t3-code", version: "3.0.0" });
  const context: GatewayToolContext = {
    port: input.port,
    grants: input.grants,
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
    ...(input.repositoryAllowlist === undefined
      ? {}
      : { repositoryAllowlist: input.repositoryAllowlist }),
    ...(input.events === undefined ? {} : { events: input.events }),
    ...(input.health === undefined ? {} : { health: input.health }),
  };

  const hasScope = (environmentId: string, scope: "read" | "delivery") => {
    const grants = typeof input.grants === "function" ? input.grants() : input.grants;
    return grants[environmentId]?.includes(scope) === true;
  };
  const activeSubscriptions = new Set<string>();
  const initializingSubscriptions = new Set<string>();
  const bufferedEvents = new Map<string, Array<import("./events.ts").GatewayEvent>>();
  const deliveryChains = new Map<string, Promise<void>>();
  const forwardedSequences = new Map<string, number>();
  const notify = async (subscriptionId: string, event: import("./events.ts").GatewayEvent) => {
    if (!hasScope(event.environmentId, "read")) return;
    await server.server.notification({
      method: "notifications/t3/events",
      params: { schemaVersion: "3", subscriptionId, event },
    } as never);
    forwardedSequences.set(
      subscriptionId,
      Math.max(forwardedSequences.get(subscriptionId) ?? 0, event.sequence),
    );
  };
  const enqueue = (subscriptionId: string, event: import("./events.ts").GatewayEvent) => {
    const previous = deliveryChains.get(subscriptionId) ?? Promise.resolve();
    const next = previous.then(() => notify(subscriptionId, event));
    deliveryChains.set(
      subscriptionId,
      next.catch(() => undefined),
    );
    return next;
  };
  const enqueueCatchUp = (subscriptionId: string) => {
    const previous = deliveryChains.get(subscriptionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (input.events === undefined) return;
      const subscription = input.events.subscriptionById(subscriptionId);
      if (subscription === undefined || !hasScope(subscription.environmentId, "read")) return;
      let afterSequence = Math.max(
        subscription.ackedSequence,
        forwardedSequences.get(subscriptionId) ?? 0,
      );
      for (;;) {
        const replay = input.events.history(
          subscription.environmentId,
          afterSequence,
          500,
          subscription.types,
        );
        for (const event of replay) {
          await notify(subscriptionId, event);
          afterSequence = event.sequence;
        }
        if (replay.length < 500) break;
      }
    });
    deliveryChains.set(
      subscriptionId,
      next.catch(() => undefined),
    );
    return next;
  };
  const activateSubscription = async (subscriptionId: string) => {
    if (input.events === undefined) return;
    const subscription = input.events.subscriptionById(subscriptionId);
    if (subscription === undefined) return;
    const delivered = new Set<string>();
    initializingSubscriptions.add(subscriptionId);
    bufferedEvents.set(subscriptionId, []);
    try {
      let afterSequence = subscription.ackedSequence;
      for (;;) {
        const replay = input.events.history(
          subscription.environmentId,
          afterSequence,
          500,
          subscription.types,
        );
        for (const event of replay) {
          delivered.add(event.eventId);
          await enqueue(subscriptionId, event);
          afterSequence = event.sequence;
        }
        if (replay.length < 500) break;
      }
      for (;;) {
        const buffered = bufferedEvents.get(subscriptionId) ?? [];
        if (buffered.length === 0) break;
        bufferedEvents.set(subscriptionId, []);
        for (const event of buffered.toSorted((left, right) => left.sequence - right.sequence)) {
          if (delivered.has(event.eventId)) continue;
          delivered.add(event.eventId);
          await enqueue(subscriptionId, event);
        }
      }
      activeSubscriptions.add(subscriptionId);
    } finally {
      initializingSubscriptions.delete(subscriptionId);
      bufferedEvents.delete(subscriptionId);
    }
  };
  const unsubscribe = input.events?.onEvent((event) => {
    for (const subscriptionId of input.events?.matchingSubscriptions(event) ?? []) {
      if (!hasScope(event.environmentId, "read")) {
        input.events?.ack(subscriptionId, event.sequence);
        forwardedSequences.set(subscriptionId, event.sequence);
        continue;
      }
      if (initializingSubscriptions.has(subscriptionId)) {
        const pending = bufferedEvents.get(subscriptionId) ?? [];
        pending.push(event);
        bufferedEvents.set(subscriptionId, pending);
      } else if (activeSubscriptions.has(subscriptionId)) {
        void enqueueCatchUp(subscriptionId).catch(() => undefined);
      }
    }
  });

  for (const [name, [description, inputSchema]] of Object.entries(TOOL_SPECS)) {
    server.registerTool(
      name,
      { description, inputSchema: z.strictObject(inputSchema) },
      async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        const responseContext = requestContext(args);
        try {
          const aliasAction = LIFECYCLE_ALIASES[name];
          const toolName = aliasAction === undefined ? name : "t3_control_thread";
          const normalizedArgs =
            aliasAction === undefined ? args : { ...args, action: aliasAction };
          const value = await callGatewayTool(context, toolName, normalizedArgs);
          if (
            (name === "t3_subscribe_events" || name === "t3_replay_events") &&
            input.events !== undefined
          ) {
            const subscriptionId = (value as { subscriptionId: string }).subscriptionId;
            await activateSubscription(subscriptionId);
          }
          return success(value, responseContext);
        } catch (error) {
          return failure(error, responseContext);
        }
      },
    );
  }

  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close: async () => {
      unsubscribe?.();
      await server.close();
    },
  };
}
