import { expect, it } from "@effect/vitest";
import {
  answerGatewayPortCall,
  type GatewayRuntimePort,
  withinModes,
} from "@t3tools/client-runtime/gateway";
import {
  EnvironmentId,
  McpGatewayRelayEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import { SERVER_SUPERSEDED_TOOLS } from "@t3tools/mcp-gateway/catalog";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpGatewayBrokerModule from "../McpGatewayBroker.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import { layerAgentsToolkit } from "../McpHttpServer.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";
import { CODE_PAIRED_SUBJECT, layerDependencies } from "../McpGatewayBroker.testkit.ts";

const localId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-agents-mcp-test");

const readOnlyClient = {
  sessionId: "session-read-only",
  label: "Read-only client",
  access: "read-only" as const,
};

const makeInvocation = (
  capabilities: ReadonlyArray<"orchestration" | "preview">,
  outsideClient?: typeof readOnlyClient,
) => ({
  environmentId: localId,
  thread:
    outsideClient === undefined
      ? {
          threadId,
          providerSessionId: "provider-session-agents-test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client: outsideClient,
  requestNamespace: `thread:${threadId}`,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const remoteId = "environment-remote";
const decodeRelayEvent = Schema.decodeEffect(McpGatewayRelayEvent);

const makeLayer = (
  listedFor: Array<string>,
  relayed?: Array<{ method: string; args: unknown }>,
  scheduledOn: Array<string> = [],
  callerModes?: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1],
  overrides: Partial<GatewayRuntimePort> = {},
  /** Answers each relayed call in place of the fixed answers below. */
  relay?: (event: McpGatewayRelayEvent) => Promise<unknown>,
) => {
  const port = {
    scheduledTask: async (environmentId: string) => {
      scheduledOn.push(environmentId);
      return { id: "scheduled-task:local" };
    },
    listEnvironments: async () => [
      {
        environmentId: localId,
        label: "Local",
        targetKind: "primary",
        connectionState: "connected",
      },
    ],
    listProjects: async (environmentId: string) => {
      listedFor.push(environmentId);
      return {
        items: [{ id: "project-1", title: "kaizen", repository: undefined }],
        snapshotAt: "snapshot-1",
      };
    },
    ...overrides,
  } as unknown as GatewayRuntimePort;
  const base = layerAgentsToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      callerModes === undefined
        ? McpToolAccessTestkit.liveThreadsLayer
        : Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, callerModes)),
          }),
    ),
    Layer.provide(
      Layer.succeed(LocalGatewayPort, {
        environmentId: localId,
        label: "Local",
        port,
        events: { subscribe: () => () => undefined },
      }),
    ),
  );
  if (relayed === undefined) return base;
  // A connected app granted read access to one other environment.
  const answers: Record<string, unknown> = {
    listEnvironments: [
      {
        environmentId: localId,
        label: "Local",
        targetKind: "bearer",
        connectionState: "connected",
      },
      {
        environmentId: remoteId,
        label: "Remote",
        targetKind: "bearer",
        connectionState: "connected",
      },
    ],
    listProjects: { items: [{ id: "project-2", title: "remote-app" }], snapshotAt: "snapshot-2" },
    createThread: { status: "accepted", threadId: "thread-remote", requestId: "request-remote" },
    scheduledTask: {
      tasks: [
        { id: "task-wide", runtimeMode: "full-access", interactionMode: "default", threadId: null },
      ],
    },
  };
  const broker = Layer.effect(
    McpGatewayBroker,
    Effect.gen(function* () {
      const broker = yield* McpGatewayBrokerModule.make;
      yield* broker
        .connect("desktop", { [remoteId]: ["read", "create", "send"] }, CODE_PAIRED_SUBJECT)
        .pipe(
          Stream.runForEach((event) => {
            relayed.push({ method: event.method, args: event.args });
            const ids = { connectionId: event.connectionId, invocationId: event.invocationId };
            if (relay === undefined) {
              return broker.respond("desktop", { ...ids, result: answers[event.method] });
            }
            return Effect.promise(() =>
              relay(event).then(
                (result) => ({ result }),
                (error: Error) => ({ error: error.message }),
              ),
            ).pipe(Effect.flatMap((outcome) => broker.respond("desktop", { ...ids, ...outcome })));
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
      return broker;
    }),
  ).pipe(Layer.provide(layerDependencies()));
  return base.pipe(Layer.provide(broker));
};

const callTool = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<"orchestration" | "preview"> = ["orchestration"],
  outsideClient?: typeof readOnlyClient,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          makeInvocation(capabilities, outsideClient),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("adds every tool that needs no event store and is not a lifecycle alias", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = new Map(server.tools.map(({ tool }) => [tool.name, tool]));
    expect(tools.has("t3_list_projects")).toBe(true);
    expect(tools.has("t3_list_environments")).toBe(true);
    expect(tools.has("t3_subscribe_events")).toBe(false);
    expect(tools.has("t3_control_thread")).toBe(true);
    for (const alias of SERVER_SUPERSEDED_TOOLS) expect(tools.has(alias)).toBe(false);
    const schema = tools.get("t3_get_thread")!.inputSchema as unknown as {
      properties: Record<string, unknown>;
      required?: Array<string>;
    };
    expect(schema.properties.environmentId).toBeDefined();
    expect(schema.required ?? []).not.toContain("environmentId");
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("runs tools on this environment when no other is reachable", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {});
    expect(result.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    expect(result.structuredContent).toMatchObject({ data: { items: [{ title: "kaizen" }] } });
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("refuses chats whose credential lacks orchestration", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {}, ["preview"]);
    expect(result.isError).toBe(true);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("refuses environments no connected app grants", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", { environmentId: remoteId });
    expect(result.isError).toBe(true);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("reaches granted environments through the connected app", () => {
  const listedFor: Array<string> = [];
  const relayed: Array<{ method: string; args: unknown }> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {});
    expect(result.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    expect(relayed).toEqual([
      { method: "listEnvironments", args: [] },
      { method: "listProjects", args: [remoteId] },
    ]);
    const [text] = result.content as ReadonlyArray<{ readonly text: string }>;
    expect(text!.text).toContain("kaizen");
    expect(text!.text).toContain("remote-app");
  }).pipe(Effect.provide(makeLayer(listedFor, relayed)));
});

it.effect("schedules on this chat's environment while another device's app is connected", () => {
  const relayed: Array<{ method: string; args: unknown }> = [];
  const scheduledOn: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_create_scheduled_task", {
      prompt: "Review what the agents did today.",
      profileId: "reviewer",
      projectId: "project-1",
      cron: "0 4 * * *",
      timezone: "Asia/Bangkok",
    });
    expect(result.isError).toBe(false);
    expect(scheduledOn).toEqual([localId]);
    expect(relayed).toEqual([]);
  }).pipe(Effect.provide(makeLayer([], relayed, scheduledOn)));
});

it.effect("lets a read-only client read but not change anything", () => {
  const listedFor: Array<string> = [];
  const scheduledOn: Array<string> = [];
  return Effect.gen(function* () {
    const read = yield* callTool(
      "t3_list_projects",
      { environmentId: localId },
      ["orchestration"],
      readOnlyClient,
    );
    expect(read.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    const write = yield* callTool(
      "t3_create_scheduled_task",
      {
        environmentId: localId,
        prompt: "Review what the agents did today.",
        profileId: "reviewer",
        projectId: "project-1",
        cron: "0 4 * * *",
        timezone: "Asia/Bangkok",
      },
      ["orchestration"],
      readOnlyClient,
    );
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write.structuredContent)).toContain("read-only access");
    expect(scheduledOn).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor, undefined, scheduledOn)));
});

it.effect("keeps a chat from starting work on another machine above its own modes", () => {
  const relayed: Array<{ method: string; args: unknown }> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_create_thread", {
      environmentId: remoteId,
      projectId: "project-2",
      title: "Escalate",
      runtimeMode: "full-access",
      idempotencyKey: "escalate-1",
    });
    expect(relayed.filter((call) => call.method === "createThread")).toEqual([]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("broader than this chat's");
    const within = yield* callTool("t3_create_thread", {
      environmentId: remoteId,
      projectId: "project-2",
      title: "Plan",
      interactionMode: "plan",
      idempotencyKey: "plan-1",
    });
    expect(within.isError).toBe(false);
    expect(relayed.filter((call) => call.method === "createThread")).toHaveLength(1);
  }).pipe(
    Effect.provide(
      makeLayer([], relayed, [], { runtimeMode: "approval-required", interactionMode: "plan" }),
    ),
  );
});

/** What each mutating tool reaches on the port, against work that runs in full-access/default. */
const wideWork = (calls: Array<string>) => {
  const record =
    (method: string) =>
    async (...args: ReadonlyArray<unknown>) => {
      const request = args[1] as { readonly action?: string } | undefined;
      const operation = (args[0] as { readonly operation?: string } | undefined)?.operation;
      calls.push(
        method === "scheduledTask" || method === "todo" || method === "threadTask"
          ? `${method}:${request?.action}`
          : operation === undefined
            ? method
            : `executeOperation:${operation}`,
      );
      return method === "scheduledTask" && request?.action === "list"
        ? {
            tasks: [
              {
                id: "task-wide",
                runtimeMode: "full-access",
                interactionMode: "default",
                threadId: null,
              },
            ],
          }
        : {
            status: "accepted",
            threadId: "thread-wide",
            requestId: "request-wide",
            profile: {},
            skill: {},
          };
    };
  return {
    listProjects: async () => ({
      items: [
        {
          id: "project-1",
          title: "t3code",
          repositoryIdentity: { owner: "jayleaton", name: "t3code" },
        },
      ],
      snapshotAt: "snapshot-1",
    }),
    listProfiles: async () => [
      {
        profileId: "wide",
        name: "Wide",
        runtimeMode: "full-access",
        interactionMode: "default",
        skillIds: ["skill-wide"],
        revision: 1,
      },
    ],
    getThread: async (_environmentId: string, id: string) => ({
      id,
      title: "Wide",
      runtimeMode: "full-access",
      interactionMode: "default",
      pendingApprovals: [
        { requestId: "approval-command", requestKind: "command" },
        { requestId: "approval-edit", requestKind: "file-change" },
      ],
      pendingQuestions: [
        {
          questionRequestId: "question-1",
          askedAt: "2026-11-11T00:00:00.000Z",
          questions: [
            {
              questionId: "q1",
              header: "Go?",
              question: "Shall I go on?",
              multiSelect: false,
              allowsFreeText: true,
              options: [],
            },
          ],
        },
      ],
    }),
    syncAgentLibrary: async () => undefined,
    scheduledTask: record("scheduledTask"),
    respondToApproval: record("respondToApproval"),
    respondToUserInput: record("respondToUserInput"),
    executeOperation: record("executeOperation"),
    createProfile: record("createProfile"),
    updateProfile: record("updateProfile"),
    deleteProfile: record("deleteProfile"),
    updateSkill: record("updateSkill"),
    deleteSkill: record("deleteSkill"),
    createSkill: record("createSkill"),
    settleThread: record("settleThread"),
    unsettleThread: record("unsettleThread"),
    setThreadParent: record("setThreadParent"),
    todo: record("todo"),
    threadTask: record("threadTask"),
    focusDevice: record("focusDevice"),
    openThread: record("openThread"),
  } as unknown as Partial<GatewayRuntimePort>;
};

const PR = { projectId: "project-1", repository: "t3code", number: 7 };
const MUTATING_TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  [
    "t3_create_scheduled_task",
    { prompt: "Ship it.", profileId: "wide", projectId: "project-1", cron: "0 4 * * *" },
    "scheduledTask:create",
  ],
  [
    "t3_update_scheduled_task",
    { taskId: "task-wide", patch: { prompt: "Ship it now." } },
    "scheduledTask:update",
  ],
  ["t3_run_scheduled_task", { taskId: "task-wide" }, "scheduledTask:run"],
  [
    "t3_respond_to_approval",
    {
      threadId: "thread-wide",
      approvalRequestId: "approval-command",
      decision: "accept",
      confirmDestructive: true,
      idempotencyKey: "approve-1",
    },
    "respondToApproval",
  ],
  [
    "t3_answer_question",
    { threadId: "thread-wide", answers: [{ text: "Yes" }], idempotencyKey: "answer-1" },
    "respondToUserInput",
  ],
  [
    "t3_apply_patch",
    {
      projectId: "project-1",
      patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
      idempotencyKey: "patch-1",
    },
    "executeOperation:git.apply_patch",
  ],
  [
    "t3_create_branch",
    { projectId: "project-1", branch: "wide", idempotencyKey: "branch-1" },
    "executeOperation:git.create_branch",
  ],
  [
    "t3_commit_changes",
    { projectId: "project-1", message: "Wide", idempotencyKey: "commit-1" },
    "executeOperation:git.commit",
  ],
  [
    "t3_create_pr",
    {
      projectId: "project-1",
      repository: "t3code",
      owner: "jayleaton",
      headBranch: "wide",
      baseBranch: "main",
      title: "Wide",
      draft: true,
      idempotencyKey: "pr-1",
    },
    "executeOperation:git.create_pr",
  ],
  [
    "t3_update_pr",
    { ...PR, title: "Wider", idempotencyKey: "pr-update-1" },
    "executeOperation:pr.update",
  ],
  [
    "t3_reply_review_comment",
    { ...PR, commentId: "comment-1", body: "Done.", idempotencyKey: "reply-1" },
    "executeOperation:pr.reply",
  ],
  [
    "t3_publish_pr",
    { ...PR, confirmDestructive: true, idempotencyKey: "publish-1" },
    "executeOperation:pr.publish",
  ],
  [
    "t3_apply_review_fixes",
    { ...PR, threadId: "thread-wide", commentIds: ["comment-1"], idempotencyKey: "fixes-1" },
    "executeOperation:pr.apply_review_fixes",
  ],
  ["t3_reclaim_worktree", { threadId: "thread-wide" }, "executeOperation:worktree.reclaim"],
  [
    "t3_create_agent",
    {
      name: "Wide",
      providerLabel: "Codex",
      modelLabel: "gpt-5",
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    "createProfile",
  ],
  ["t3_update_agent", { profileId: "wide", patch: { systemPrompt: "Go wide." } }, "updateProfile"],
  ["t3_delete_agent", { profileId: "wide" }, "deleteProfile"],
  ["t3_update_skill", { skillId: "skill-wide", patch: { content: "Go wide." } }, "updateSkill"],
  ["t3_delete_skill", { skillId: "skill-wide" }, "deleteSkill"],
  [
    "t3_create_skill",
    { name: "Wide", description: "Goes wide.", content: "Go wide." },
    "createSkill",
  ],
  ["t3_delete_scheduled_task", { taskId: "task-wide" }, "scheduledTask:delete"],
  ["t3_settle_thread", { threadId: "thread-wide", confirmed: true }, "settleThread"],
  ["t3_unsettle_thread", { threadId: "thread-wide" }, "unsettleThread"],
  ["t3_set_thread_parent", { threadId: "thread-wide", parentThreadId: null }, "setThreadParent"],
  ["t3_add_todo", { projectId: "project-1", text: "Go wide." }, "todo:add"],
  ["t3_update_todo", { todoId: "todo-1", text: "Go wider." }, "todo:update"],
  ["t3_remove_todo", { todoId: "todo-1" }, "todo:remove"],
  ["t3_settle_todo", { todoId: "todo-1" }, "todo:settle"],
  ["t3_unsettle_todo", { todoId: "todo-1" }, "todo:unsettle"],
  ["t3_task_assign", { threadId: "thread-wide", summary: "Go wide." }, "threadTask:assign"],
  [
    "t3_task_update",
    { threadId: "thread-wide", expectedRevision: 1, summary: "Went wide." },
    "threadTask:update",
  ],
  ["t3_settle_after_turn", { threadId: "thread-wide" }, "threadTask:settleAfterTurn"],
  ["t3_focus_device", { device: "phone", threadId: "thread-wide" }, "focusDevice"],
  ["t3_open_thread", { threadId: "thread-wide" }, "openThread"],
];

it.effect("keeps every mutating tool within the calling chat's modes", () =>
  Effect.gen(function* () {
    const callers = [
      ["approval-required", { runtimeMode: "approval-required", interactionMode: "default" }],
      ["plan", { runtimeMode: "full-access", interactionMode: "plan" }],
      ["full-access", { runtimeMode: "full-access", interactionMode: "default" }],
    ] as const;
    const problems: Array<string> = [];
    for (const [label, modes] of callers) {
      for (const [name, args, reached] of MUTATING_TOOLS) {
        const calls: Array<string> = [];
        const result = yield* callTool(name, args).pipe(
          Effect.provide(makeLayer([], undefined, [], modes, wideWork(calls))),
        );
        // The full-access caller proves each call is well formed and reaches the port.
        if (calls.includes(reached) !== (label === "full-access")) {
          problems.push(`${label} ${name}: ${JSON.stringify(result.structuredContent)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }),
);

it.effect("lets a narrower chat answer only what it could do itself", () =>
  Effect.gen(function* () {
    const respond = (
      modes: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1],
      approvalRequestId: string,
      decision: string,
    ) => {
      const calls: Array<string> = [];
      return callTool("t3_respond_to_approval", {
        threadId: "thread-wide",
        approvalRequestId,
        decision,
        confirmDestructive: true,
        idempotencyKey: `${approvalRequestId}-${decision}`,
      }).pipe(
        Effect.provide(makeLayer([], undefined, [], modes, wideWork(calls))),
        Effect.as(calls),
      );
    };
    const edits = { runtimeMode: "auto-accept-edits", interactionMode: "default" } as const;
    expect(yield* respond(edits, "approval-edit", "accept")).toEqual(["respondToApproval"]);
    expect(yield* respond(edits, "approval-command", "accept")).toEqual([]);
    // Declining is always open: it is how a chat stops work it could not approve.
    const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;
    expect(yield* respond(supervised, "approval-command", "decline")).toEqual([
      "respondToApproval",
    ]);
  }),
);

it.effect("keeps a chat from running a scheduled task on another machine above its modes", () =>
  Effect.gen(function* () {
    const runsFor = (modes: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1]) => {
      const relayed: Array<{ method: string; args: unknown }> = [];
      return callTool("t3_run_scheduled_task", {
        environmentId: remoteId,
        taskId: "task-wide",
      }).pipe(
        Effect.provide(makeLayer([], relayed, [], modes)),
        Effect.map(() =>
          relayed.filter(
            (call) =>
              call.method === "scheduledTask" &&
              (call.args as ReadonlyArray<{ action?: string }>)[1]?.action === "run",
          ),
        ),
      );
    };
    expect(
      yield* runsFor({ runtimeMode: "approval-required", interactionMode: "default" }),
    ).toEqual([]);
    expect(yield* runsFor({ runtimeMode: "full-access", interactionMode: "default" })).toHaveLength(
      1,
    );
  }),
);

it.effect("keeps a narrower chat from copying broader agents to another machine", () =>
  Effect.gen(function* () {
    const replicatedFor = (modes: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1]) => {
      const relayed: Array<{ method: string; args: unknown }> = [];
      return callTool("t3_create_agent", {
        name: "Planner",
        providerLabel: "Codex",
        modelLabel: "gpt-5",
        runtimeMode: "full-access",
        interactionMode: "plan",
      }).pipe(
        Effect.provide(makeLayer([], relayed, [], modes, wideWork([]))),
        Effect.map(() => relayed.filter((call) => call.method === "replicateProfiles")),
      );
    };
    // Sharing copies every agent here, the full-access "wide" one included.
    expect(yield* replicatedFor({ runtimeMode: "full-access", interactionMode: "plan" })).toEqual(
      [],
    );
    expect(
      yield* replicatedFor({ runtimeMode: "full-access", interactionMode: "default" }),
    ).toHaveLength(1);
  }),
);

it.effect("clamps a relayed call where it runs, whatever the relaying server was told", () =>
  Effect.gen(function* () {
    // The relaying server checked a thread a lying app reported as plan; the app answering
    // the call reads the target itself and finds it full-access.
    const event = yield* decodeRelayEvent({
      type: "invoke",
      connectionId: "connection-1",
      invocationId: "invocation-1",
      method: "sendMessage",
      args: [
        {
          environmentId: remoteId,
          threadId: "thread-wide",
          text: "Go wide.",
          messageId: "message-1",
          requestId: "request-1",
        },
      ],
      modeCeiling: { runtimeMode: "approval-required", interactionMode: "plan" },
    });
    const sent: Array<string> = [];
    const appPort = {
      ...wideWork(sent),
      sendMessage: async () => {
        sent.push("sendMessage");
        return { status: "accepted", threadId: "thread-wide", requestId: "request-1" };
      },
    } as unknown as GatewayRuntimePort;
    const destination = withinModes(appPort, event.modeCeiling);
    const answered = yield* Effect.promise(() =>
      (destination.sendMessage as (...args: ReadonlyArray<unknown>) => Promise<unknown>)(
        ...event.args,
      ).then(
        () => "sent",
        (error: Error) => error.message,
      ),
    );
    expect(answered).toContain("broader than this chat's");
    expect(sent).toEqual([]);
  }),
);

it.effect(
  "a relayed call is refused where it runs, even when the relaying app lies to this server",
  () =>
    Effect.gen(function* () {
      const reached: Array<string> = [];
      const truth = wideWork(reached) as unknown as GatewayRuntimePort;
      const relay = (event: McpGatewayRelayEvent) =>
        // The app tells this server the thread is as narrow as the chat, so the clamp here passes;
        // every other call runs through the real answering path against the thread as it is.
        event.method === "getThread"
          ? truth
              .getThread(String(event.args[0]), String(event.args[1]))
              .then((thread) => ({ ...thread, runtimeMode: "approval-required" }))
          : answerGatewayPortCall(
              {
                ...truth,
                listEnvironments: async () => [
                  {
                    environmentId: remoteId,
                    label: "Remote",
                    targetKind: "bearer",
                    connectionState: "connected",
                  },
                ],
              },
              { [remoteId]: ["read", "create", "send"] },
              event.method,
              event.args,
              event.modeCeiling,
            );
      const result = yield* callTool("t3_answer_question", {
        environmentId: remoteId,
        threadId: "thread-wide",
        answers: [{ text: "Yes" }],
        idempotencyKey: "answer-relayed",
      }).pipe(
        Effect.provide(
          makeLayer(
            [],
            [],
            [],
            { runtimeMode: "approval-required", interactionMode: "default" },
            {},
            relay,
          ),
        ),
      );
      expect(reached).not.toContain("respondToUserInput");
      expect(JSON.stringify(result.structuredContent)).toContain("broader than this chat's");
    }),
);

it.effect("keeps a chat below full access from changing the shared skill library", () =>
  Effect.gen(function* () {
    const updatesFor = (modes: Parameters<typeof McpToolAccessTestkit.liveThreadShell>[1]) => {
      const updates: Array<string> = [];
      const updateSkill = async (_environmentId: string, skillId: string) => {
        updates.push(skillId);
        return { skillId };
      };
      return callTool("t3_update_skill", {
        skillId: "unused",
        patch: { content: "Take more notes" },
      }).pipe(
        Effect.provide(
          makeLayer([], undefined, [], modes, {
            updateSkill,
            listProfiles: async () => [],
          } as never),
        ),
        Effect.as(updates),
      );
    };
    // No agent uses the skill, but every machine syncs it to whichever agent adopts it later.
    expect(
      yield* updatesFor({ runtimeMode: "auto-accept-edits", interactionMode: "default" }),
    ).toEqual([]);
    expect(
      yield* updatesFor({ runtimeMode: "full-access", interactionMode: "default" }),
    ).toHaveLength(1);
  }),
);
