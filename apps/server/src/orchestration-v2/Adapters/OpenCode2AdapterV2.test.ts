import * as NodeURL from "node:url";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { TestClock } from "effect/testing";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  OPENCODE_2_STILL_STOPPING,
  OPENCODE_PROVIDER,
  t3McpServerName,
} from "@t3tools/provider-opencode/testing";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@t3tools/provider-testing/replayGate";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (
  type: string,
  data: Record<string, unknown>,
  label?: string,
  version = 1,
): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}0000`,
      created: 1,
      type,
      ...(type.startsWith("rpc.") ? { location: { directory: WORK } } : {}),
      data,
      durable: { ...durable.durable, version },
    },
  },
  ...(label === undefined ? {} : { label }),
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];
const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
const TITLE = "Prime check";
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: t3Rules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

const emptyShellInventory: ReadonlyArray<ProviderReplayEntry> = [
  out("shell.list", "<any>"),
  reply("shell.list", { location: { directory: WORK }, data: [] }),
];

const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

const withInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> => {
  const first = entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "type" in entry.frame &&
      [
        "session.prompt",
        "session.command",
        "session.compact",
        "command.list",
        "skill.list",
        "rpc.call",
      ].includes(String(entry.frame.type)),
  );
  const after = entries.findIndex(
    (entry, index) =>
      index < first &&
      entry.type === "emit_inbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "operation" in entry.frame &&
      entry.frame.operation === "mcp.add",
  );
  const at = after < 0 ? first : after + 1;
  return first < 0
    ? entries
    : [
        ...entries.slice(0, at),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "t3-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        ...entries.slice(at),
      ];
};

const openCode2ReplayRuntimeWithInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: { readonly external?: boolean },
) => openCode2ReplayRuntime(withInstructions(entries), options);

const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];
const directoryModels = (directory: string): ReadonlyArray<ProviderReplayEntry> => [
  out("model.list", { "location[directory]": directory }),
  reply("model.list", { ...modelCatalog, location: { directory } }),
];

const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const buildPaths = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
const agentList = {
  location: { directory: WORK },
  data: [
    {
      id: "build",
      name: "Build",
      request: { settings: {}, headers: {}, body: {} },
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...buildPaths],
    },
  ],
};
const supervisedRules = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...buildPaths,
  ...mcpRules,
];

const shellAsk = {
  data: {
    id: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
    sessionID: SESSION,
    action: "shell",
    resources: ["echo FIRST"],
    save: ["echo *"],
    source: { type: "tool", messageID: "msg_0eb7c4330001dYFQKuTpfD780v", id: "call_1" },
  },
};
const shellAskEvent = event("permission.asked", shellAsk.data);
const colorForm = {
  id: "frm_0eb79ab35001fkvFECSh3wYNVD",
  sessionID: SESSION,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Color preference",
      description: "Which color do you prefer?",
      type: "string",
      options: [{ value: "Red", label: "Red" }],
      custom: true,
    },
  ],
};

const resumed = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly version?: "2.2.1" | "2.2.5" | "2.2.6";
    readonly shellRecovery?: ReadonlyArray<ProviderReplayEntry>;
    readonly lastRunOrdinal?: number;
    readonly goal?: OrchestrationV2ProviderThread["goal"];
    readonly external?: boolean;
    readonly supervised?: boolean;
    readonly processExit?: Effect.Effect<void>;
    readonly beforeResponse?: (path: string) => Effect.Effect<void>;
    readonly borrowers?: { current: number };
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly onPrompt?: (input: unknown) => void;
  },
) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      [
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        ...(options?.version === "2.2.5" || options?.version === "2.2.6"
          ? [out("rpc.call", "<any>"), reply("rpc.call", { output: null })]
          : []),
        ...(options?.shellRecovery ??
          (options?.version === undefined
            ? []
            : [
                ...(options.version === "2.2.6"
                  ? [out("job.list", { kind: "shell" }), reply("job.list", { data: [] })]
                  : emptyShellInventory),
              ])),
        ...withInstructions([
          ...(options?.supervised === true
            ? [
                out("agent.list", "<any>"),
                reply("agent.list", agentList),
                out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
                reply("session.update", null),
              ]
            : []),
          ...entries,
        ]),
      ],
      {
        ...(options?.version === undefined ? {} : { version: options.version }),
        ...(options?.borrowers === undefined ? {} : { borrowers: options.borrowers }),
        ...(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
        ...(options?.onPrompt === undefined ? {} : { onPrompt: options.onPrompt }),
        ...(options?.external === undefined ? {} : { external: options.external }),
        ...(options?.processExit === undefined ? {} : { processExit: options.processExit }),
        ...(options?.beforeResponse === undefined
          ? {}
          : { beforeResponse: options.beforeResponse }),
        ...(options?.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        ...(options?.attachmentsDir === undefined
          ? {}
          : { attachmentsDir: options.attachmentsDir }),
        ...(options?.resolveExtractedTextPath === undefined
          ? {}
          : { resolveExtractedTextPath: options.resolveExtractedTextPath }),
      },
    );
    const thread = yield* runtime.resumeThread({
      providerThread: {
        ...providerThread(yield* DateTime.now),
        ...(options?.lastRunOrdinal === undefined
          ? {}
          : { lastRunOrdinal: options.lastRunOrdinal }),
        ...(options?.goal === undefined ? {} : { goal: options.goal }),
      },
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(options?.supervised === true ? "approval-required" : "full-access"),
    });
    return { runtime, thread };
  });

const requestOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<
        ProviderAdapter.ProviderAdapterV2Event,
        { type: "runtime_request.updated" }
      > => event.type === "runtime_request.updated",
    ),
    Stream.map((event) => event.runtimeRequest),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const history = {
  data: [
    {
      id: "msg_0eb732081001RntUJfRtTXOAjd",
      time: { created: 1790656585885 },
      text: "Think carefully step by step about whether 391 is prime, showing your reasoning, then answer in one short sentence.",
      type: "user",
    },
    {
      id: "msg_0eb7320a9001vve3OV5uNi2HRT",
      time: { created: 1790656585925, streamed: 1790656590719, completed: 1790656590736 },
      type: "assistant",
      agent: "build",
      model: { id: "space-bunny-free", providerID: "opencode", variant: "high" },
      content: [
        { type: "reasoning", text: "Check divisibility up to sqrt(391)." },
        { type: "text", text: "391 is not prime: it's the product 17 × 23." },
      ],
      finish: "stop",
      cost: 0,
      tokens: { input: 8701, output: 113, reasoning: 147, cache: { read: 489, write: 0 } },
    },
    {
      id: "msg_0eb733399001NhwTrB32UU6d6H",
      time: { created: 1790656590745 },
      type: "idle",
      outcome: "succeeded",
    },
  ],
  cursor: {},
};

const nativeGoal = (status: "active" | "paused" | "complete") => ({
  id: "goal-1",
  objective: "Write proof.txt",
  status,
  rounds: 2,
  maxRounds: 100,
  boot: "boot-1",
  updatedAt: 1,
  reason: "Checked proof.txt",
});

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("switches the session's model and variant before a turn that changed them", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.switchModel", {
          sessionID: SESSION,
          model: { providerID: "openrouter", id: "deepseek/deepseek-v4-flash", variant: "high" },
        }),
        reply("session.switchModel", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      assert.deepEqual(thread.nativeMetadata?.modelSelection, {
        ...bigPickle,
        options: [{ id: "variant", value: "default" }],
      });
      assert.equal(bigPickle.options, undefined);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        turnInput(thread, {
          instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
          options: [{ id: "variant", value: "high" }],
        }),
      );
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("never sends a saved variant the catalog model does not list", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        turnInput(thread, { ...bigPickle, options: [{ id: "variant", value: "medium" }] }),
      );
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("renames the session before the first turn after the thread was renamed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.update", { sessionID: SESSION, title: "Prime factors of 391" }),
        reply("session.update", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const renamed = {
        ...turnInput(thread),
        appThread: { title: "Prime factors of 391" } as OrchestrationV2AppThread,
      };
      const first = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(renamed);
      assert.equal((yield* Fiber.join(first))?.status, "completed");
      const second = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn({
        ...renamed,
        runId: RunId.make("run:opencode2-adapter:2"),
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
      });
      assert.equal((yield* Fiber.join(second))?.status, "completed");
    }),
  );

  it.effect("ends a turn on the provider thread it started on", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const forkedRow = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:forked-run-row"),
      };
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(forkedRow));
      assert.equal((yield* Fiber.join(terminal))?.providerThreadId, forkedRow.id);
    }),
  );

  // regression: #18315 OpenCode Go quota stops were not shown as usage limits
  it.effect.each([
    ["provider.quota", "usage_limit"],
    ["provider.rate-limit", "usage_limit"],
    ["provider", "provider_error"],
  ] as const)("classifies a %s execution failure as %s", ([code, failureClass]) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.failed", {
          sessionID: SESSION,
          error: { type: code, message: "Provider rejected the request" },
        }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.deepEqual(ended?.failure, {
        class: failureClass,
        code,
        message: "Provider rejected the request",
        retryable: null,
      });
    }),
  );

  // OpenCode types an empty balance as provider.quota too, but answers it with
  // HTTP 402 and it never resets. Usage windows and budgets arrive as 429.
  it.effect.each([
    {
      name: "an out-of-funds provider.quota (402)",
      failureClass: "provider_error",
      error: {
        type: "provider.quota",
        message: "Upstream request failed: Insufficient account funds",
        status: 402,
      },
    },
    {
      name: "a provider.quota usage window (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.quota",
        message: "Subscription quota exceeded.",
        status: 429,
        response: {
          body: JSON.stringify({
            type: "error",
            error: { type: "GoUsageLimitError", message: "Subscription quota exceeded." },
          }),
        },
      },
    },
    {
      name: "a provider.quota account budget (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.quota",
        message: "Upstream request failed: Account budget exceeded",
        status: 429,
      },
    },
    {
      name: "a provider.rate-limit failure (429)",
      failureClass: "usage_limit",
      error: {
        type: "provider.rate-limit",
        message: "Rate limit exceeded: free-models-per-min.",
        status: 429,
      },
    },
    {
      name: "a Claude limit without a reset timestamp",
      failureClass: "usage_limit",
      error: {
        type: "provider.unknown",
        message: "You've hit your session limit · resets 5:20pm (Europe/Berlin)",
      },
    },
    {
      name: "an unrelated provider.unknown failure",
      failureClass: "provider_error",
      error: {
        type: "provider.unknown",
        message: "Request failed. Resets at 2026-11-02T20:00:00Z.",
      },
    },
  ] as const)("classifies $name as $failureClass", ({ error, failureClass }) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.failed", { sessionID: SESSION, error }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.deepEqual(ended?.failure, {
        class: failureClass,
        code: error.type,
        message: error.message,
        retryable: null,
      });
    }),
  );

  // regression: #29289 Claude weekly limits through claude-agent lost their usage-limit reset
  it.effect(
    "classifies a Claude weekly limit as a usage limit that resets at its reported time",
    () =>
      Effect.gen(function* () {
        const message =
          "You've hit your weekly limit · resets 9pm (Europe/Paris) Resets at 2026-11-02T20:00:00.000Z.";
        const { runtime, thread } = yield* resumed([
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.failed", {
            sessionID: SESSION,
            error: { type: "provider.unknown", message },
          }),
        ]);
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        const ended = yield* Fiber.join(terminal);
        assert.equal(ended?.status, "failed");
        assert.deepEqual(ended?.failure, {
          class: "usage_limit",
          code: "provider.unknown",
          message,
          retryable: null,
          resetAt: "2026-11-02T20:00:00.000Z",
        });
      }),
  );

  it.effect("ends the turn when its terminal event is one this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.interrupted", { sessionID: SESSION, reason: "budget" }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
    }),
  );

  it.effect("keeps a turn running through a start event this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_executionstartedx",
              created: 1,
              type: "session.execution.started",
              data: { sessionID: SESSION },
              durable: "not-an-envelope",
            },
          },
        },
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const seen = yield* Fiber.join(collected);
      const terminals = seen.filter((event) => event.type === "turn.terminal");
      assert.deepEqual(
        terminals.map((event) => event.type === "turn.terminal" && event.status),
        ["completed"],
      );
      assert.isTrue(
        seen.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "DONE",
        ),
      );
    }),
  );

  it.effect("stops running turns on an external server when the session closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
        ],
        { external: true },
      ).pipe(Scope.provide(scope));
      yield* runtime.startTurn(turnInput(thread));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("sends nothing for a turn stopped while extracting document text", () =>
    Effect.gen(function* () {
      const resolving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const prompts: Array<unknown> = [];
      const { runtime, thread } = yield* resumed(
        [
          out("session.instructions.entry.put", {
            sessionID: SESSION,
            key: "t3-code",
            value: "<any>",
          }),
          reply("session.instructions.entry.put", null),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: false }),
        ],
        {
          attachmentsDir: "/attachments",
          onPrompt: (input) => prompts.push(input),
          resolveExtractedTextPath: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(resolving, undefined);
              yield* Deferred.await(release);
              return undefined;
            }),
        },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime
        .startTurn({
          ...turnInput(thread),
          message: {
            ...turnInput(thread).message,
            attachments: [
              ChatFileAttachment.make({
                type: "file",
                id: ChatAttachmentId.make(
                  "thread-opencode2-adapter-12345678-1234-1234-1234-123456789abc",
                ),
                name: "report.rtf",
                mimeType: "application/rtf",
                sizeBytes: 4,
              }),
            ],
          },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(resolving);
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(started);
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
      assert.lengthOf(prompts, 0);
    }),
  );

  const childCreated = (child: string) => ({
    sessionID: child,
    slug: "proud-canyon",
    version: "2.0.18",
    projectID: "global",
    parentID: SESSION,
    location: { directory: WORK },
    subpath: "",
    title: "Sleep",
    agent: "general",
    model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  });
  const backgroundLaunch = (child: string): ReadonlyArray<ProviderReplayEntry> => {
    const call = "call-background";
    const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: call };
    return [
      out("session.prompt", { sessionID: SESSION, text: "<any>" }),
      promptAccepted,
      event("session.execution.started", { sessionID: SESSION }),
      event("session.tool.input.started", { ...tool, name: "subagent" }),
      event("session.tool.called", {
        ...tool,
        name: "subagent",
        input: { description: "Sleep", prompt: "sleep", background: true },
        executed: false,
      }),
      event("session.created", childCreated(child)),
      event("session.tool.progress", {
        ...tool,
        metadata: { sessionID: child, status: "running" },
      }),
    ];
  };
  const withLineage = (thread: OrchestrationV2ProviderThread) => ({
    ...turnInput(thread),
    appThread: {
      id: threadId,
      title: TITLE,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    } as OrchestrationV2AppThread,
  });
  const continuationTurn = (
    thread: OrchestrationV2ProviderThread,
    offer: ProviderContinuationRequests.ProviderContinuationRequest,
    suffix = "wake",
  ) => ({
    ...withLineage(thread),
    runId: RunId.make(`run:opencode2-adapter:${suffix}`),
    runOrdinal: 2,
    providerTurnOrdinal: 2,
    attemptId: RunAttemptId.make(`attempt:opencode2-adapter:${suffix}`),
    message: {
      ...turnInput(thread).message,
      messageId: offer.messageId!,
      text: offer.detail ?? "",
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    },
  });
  const CHILD = "ses_f1485c529ffea4URrYruwEg0Ja";
  const watchBackgroundTurn = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
    Effect.gen(function* () {
      const attached = yield* Deferred.make<void>();
      const terminal = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "subagent.updated" && event.subagent.childThreadId !== null
            ? Deferred.succeed(attached, undefined)
            : Effect.void,
        ),
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
        Effect.forkScoped,
      );
      return { attached: Deferred.await(attached), terminal: Fiber.join(terminal) };
    });
  it.effect.each([false, true, "thread", "failed", "burst", "poll"] as const)(
    "tracks native background shells through launch, retained output, stop=%s",
    (stop) =>
      Effect.gen(function* () {
        const stopped = stop === true || stop === "thread" || stop === "poll";
        const exitCode = stop === "failed" ? 7 : 0;
        const shellID = "sh_background";
        const tool = {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant",
          id: "call-shell",
        };
        const gate = makeProviderReplayGate(["shell-exit"]);
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            event("session.tool.input.started", { ...tool, name: "shell" }),
            event("session.tool.called", {
              ...tool,
              name: "shell",
              input: { command: "echo retained", background: true },
              executed: false,
            }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Launched" }],
                metadata: { shellID },
                executed: false,
              },
              undefined,
              2,
            ),
            out("shell.output", "<any>"),
            reply("shell.output", {
              location: { directory: WORK },
              data: { output: "retained\n", cursor: 9, size: 9, truncated: false },
            }),
            ...(stop === "poll"
              ? [out("shell.output", "<any>"), reply("shell.output", "<hang>")]
              : []),
            event("session.execution.succeeded", { sessionID: SESSION }),
            ...(stopped
              ? []
              : [
                  event(
                    "shell.exited",
                    { id: shellID, exit: exitCode, status: "exited" },
                    "shell-exit",
                  ),
                ]),
            ...(stop === "burst"
              ? Array.from({ length: 5 }, (_, page) => [
                  out("shell.output", { cursor: String(9 + page * 65536) }),
                  reply("shell.output", {
                    location: { directory: WORK },
                    data: {
                      output:
                        page === 4 ? "x".repeat(65519) + "FINAL DIAGNOSTIC\n" : "x".repeat(65536),
                      cursor: 9 + (page + 1) * 65536,
                      size: 9 + 5 * 65536,
                      truncated: false,
                    },
                  }),
                ]).flat()
              : [
                  out("shell.output", "<any>"),
                  reply("shell.output", {
                    location: { directory: WORK },
                    data: { output: "", cursor: 9, size: 9, truncated: false },
                  }),
                ]),
            ...(stopped
              ? [
                  out("shell.remove", { id: shellID, "location[directory]": WORK }),
                  event("shell.exited", { id: shellID, exit: 143, status: "exited" }),
                  reply("shell.remove", null),
                ]
              : []),
          ],
          { replayGate: gate },
        );
        const items: Array<import("@t3tools/contracts").OrchestrationV2TurnItem> = [];
        const shellStarted = yield* Deferred.make<void>();
        const terminal = yield* runtime.events.pipe(
          Stream.tap((e) =>
            Effect.gen(function* () {
              if (e.type !== "turn_item.updated") return;
              items.push(e.turnItem);
              if (e.turnItem.type === "command_execution" && e.turnItem.output === "retained\n")
                yield* Deferred.succeed(shellStarted, undefined);
            }),
          ),
          Stream.filter((e) => e.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(withLineage(thread));
        if (stop === "poll") {
          yield* Deferred.await(shellStarted);
          yield* TestClock.adjust("2 seconds");
        }
        yield* Fiber.join(terminal);
        assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        const settled = yield* runtime.events.pipe(
          Stream.tap((e) =>
            Effect.sync(() => {
              if (e.type === "turn_item.updated") items.push(e.turnItem);
            }),
          ),
          Stream.filter(
            (e) =>
              e.type === "provider_thread.updated" &&
              e.providerThread.pendingBackgroundTasks?.length === 0,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        if (stop === "thread")
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: yield* providerTurnId,
            requestRuntimeRestart: true,
          });
        else if (stopped) yield* runtime.stopTask!({ providerThread: thread, taskId: shellID });
        else gate.release("shell-exit");
        yield* Fiber.join(settled);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.deepInclude(items.filter((i) => i.type === "command_execution").at(-1), {
          type: "command_execution",
          status: stopped ? "interrupted" : stop === "failed" ? "failed" : "completed",
          ...(stop === "failed" ? { exitCode: 7 } : {}),
          output: stop === "burst" ? "x".repeat(262127) + "FINAL DIAGNOSTIC\n" : "retained\n",
        });
        assert.isFalse(items.some((i) => i.type === "subagent"));
      }),
  );

  it.effect.each([
    "shell",
    "job",
    "fallback",
    "descendant",
    "settled",
    "exited",
    "anchored",
  ] as const)("recovers only owned native shells using %s inventory", (discovery) =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer));
      const id = "sh_recovered";
      const info = {
        id,
        command: "sleep 600",
        status: discovery === "settled" ? "exited" : "running",
        ...(discovery === "settled" ? { exit: 0 } : {}),
        cwd: WORK,
        shell: "/bin/sh",
        file: "/remote/output",
        metadata: { sessionID: SESSION },
        time: { started: 1 },
      };
      const response = (data: unknown) => ({ location: { directory: WORK }, data });
      const inventory: Array<ProviderReplayEntry> =
        discovery === "shell"
          ? []
          : [
              out("job.list", { sessionID: SESSION, kind: "shell", descendants: "true" }),
              reply(
                "job.list",
                discovery === "fallback"
                  ? { status: 404, body: {} }
                  : {
                      data: [
                        {
                          kind: "shell",
                          shellID: id,
                          sessionID: discovery === "descendant" ? "ses_descendant" : SESSION,
                          command: info.command,
                          status: discovery === "settled" ? "completed" : "running",
                        },
                      ],
                    },
              ),
            ];
      if (discovery === "shell" || discovery === "fallback")
        inventory.push(
          out("shell.list", "<any>"),
          reply(
            "shell.list",
            response([info, { ...info, id: "sh_other", metadata: { sessionID: "ses_other" } }]),
          ),
        );
      inventory.push(
        out("shell.get", { id }),
        reply("shell.get", response(info)),
        out("shell.output", { id, cursor: "0" }),
        reply(
          "shell.output",
          response({ output: "retained", cursor: 8, size: 8, truncated: false }),
        ),
      );
      const gate = makeProviderReplayGate(["recovered-exit"]);
      const { runtime, thread } = yield* resumed(
        discovery === "settled"
          ? []
          : [
              ...(discovery === "exited"
                ? [event("shell.exited", { id, exit: 0, status: "exited" }, "recovered-exit")]
                : []),
              out("shell.output", { id, cursor: "8" }),
              reply(
                "shell.output",
                response({
                  output: discovery === "exited" ? " finished" : "",
                  cursor: discovery === "exited" ? 17 : 8,
                  size: discovery === "exited" ? 17 : 8,
                  truncated: false,
                }),
              ),
              ...(discovery === "exited"
                ? []
                : [out("shell.remove", { id }), reply("shell.remove", null)]),
            ],
        {
          version: discovery === "shell" ? "2.2.1" : "2.2.6",
          shellRecovery: inventory,
          external: true,
          ...(discovery === "anchored" ? { lastRunOrdinal: 7 } : {}),
          replayGate: gate,
        },
      );
      const items: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const shellEnded = yield* Deferred.make<void>();
      const rosterEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              event.type === "provider_thread.updated" &&
              event.sessionScoped === true &&
              event.providerThread.pendingBackgroundTasks?.length === 0
            )
              yield* Deferred.succeed(rosterEnded, undefined);
            if (event.type !== "turn_item.updated" || event.turnItem.type !== "command_execution")
              return;
            items.push(event);
            if (event.turnItem.status !== "running") yield* Deferred.succeed(shellEnded, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepEqual(
        thread.pendingBackgroundTasks ?? [],
        discovery === "settled" ? [] : [{ taskId: id, kind: "command", description: info.command }],
      );
      assert.equal(
        yield* runtime.hasPendingBackgroundWorkForThread!(thread),
        discovery !== "settled",
      );
      yield* runtime.stopTask!({ providerThread: thread, taskId: "sh_other" });
      assert.equal(
        yield* runtime.hasPendingBackgroundWorkForThread!(thread),
        discovery !== "settled",
      );
      if (discovery === "exited") gate.release("recovered-exit");
      else yield* runtime.stopTask!({ providerThread: thread, taskId: id });
      yield* Deferred.await(shellEnded);
      yield* Deferred.await(rosterEnded);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      const item = items;
      const projected = item.at(0);
      const stopped = item.at(-1);
      if (stopped?.type === "turn_item.updated" && stopped.turnItem.type === "command_execution") {
        assert.equal(
          stopped.turnItem.status,
          discovery === "settled" || discovery === "exited" ? "completed" : "interrupted",
        );
        assert.equal(
          stopped.turnItem.output,
          discovery === "exited" ? "retained finished" : "retained",
        );
        assert.equal(
          stopped.turnItem.id,
          projected?.type === "turn_item.updated" ? projected.turnItem.id : undefined,
        );
      }
      assert.equal(projected?.type, "turn_item.updated");
      if (projected?.type === "turn_item.updated") {
        assert.isTrue(
          item.every(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.runId ===
                (discovery === "anchored"
                  ? idAllocator.derive.run({ threadId, ordinal: 7 })
                  : null),
          ),
        );
        assert.deepInclude(projected.turnItem, {
          type: "command_execution",
          input: info.command,
          output: "retained",
        });
      }
    }),
  );

  it.effect.each(["remove", "lookup", "output", "timeout"] as const)(
    "continues recovering and stopping native work when shell %s fails",
    (failure) =>
      Effect.gen(function* () {
        const ids = ["sh_unreachable", "sh_stoppable"];
        const info = (id: string) => ({
          id,
          command: "sleep 600",
          status: "running",
          cwd: WORK,
          shell: "/bin/sh",
          file: "/remote/output",
          metadata: { sessionID: SESSION },
          time: { started: 1 },
        });
        const response = (data: unknown) => ({ location: { directory: WORK }, data });
        const output = (id: string) => [
          out("shell.output", { id }),
          reply("shell.output", response({ output: "", cursor: 0, size: 0, truncated: false })),
        ];
        const gate = makeProviderReplayGate(["recovery-pending", "polled"]);
        const recovery = yield* resumed(
          [
            ...backgroundLaunch(CHILD),
            ...output(ids[0]!),
            out("shell.remove", { id: ids[0] }),
            reply("shell.remove", failure === "remove" ? { status: 500, body: {} } : null),
            ...output(ids[1]!),
            out("shell.remove", { id: ids[1] }),
            reply("shell.remove", null),
            out("session.interrupt", { sessionID: CHILD }),
            reply("session.interrupt", { interrupted: true }),
            out("session.interrupt", { sessionID: SESSION }),
            reply("session.interrupt", { interrupted: true }),
            event("session.execution.interrupted", { sessionID: SESSION }),
            ...(failure === "remove"
              ? [
                  ...output(ids[0]!),
                  out("shell.remove", { id: ids[0] }),
                  reply("shell.remove", null),
                ]
              : []),
          ],
          {
            version: "2.2.1",
            replayGate: gate,
            shellRecovery: [
              out("shell.list", "<any>"),
              reply("shell.list", response(ids.map(info))),
              ...(failure === "timeout"
                ? [
                    out("shell.get", { id: ids[0] }),
                    reply("shell.get", "<hang>"),
                    event(
                      "session.execution.succeeded",
                      { sessionID: "ses_unrelated" },
                      "recovery-pending",
                    ),
                    ...ids.map((id) => out("shell.output", { id })),
                    ...ids.map(() =>
                      reply(
                        "shell.output",
                        response({ output: "", cursor: 0, size: 0, truncated: false }),
                      ),
                    ),
                    event("session.execution.succeeded", { sessionID: "ses_unrelated" }, "polled"),
                  ]
                : ids.flatMap((id) => [
                    out("shell.get", { id }),
                    reply(
                      "shell.get",
                      id === ids[0] && failure === "lookup"
                        ? { status: 500, body: {} }
                        : response(info(id)),
                    ),
                    ...(id === ids[0] && failure === "lookup"
                      ? []
                      : id === ids[0] && failure === "output"
                        ? [
                            out("shell.output", { id }),
                            reply("shell.output", { status: 500, body: {} }),
                          ]
                        : output(id)),
                  ])),
            ],
          },
        ).pipe(Effect.forkScoped);
        if (failure === "timeout") {
          yield* Effect.promise(() => gate.waitForReached("recovery-pending"));
          yield* TestClock.adjust("5 seconds");
        }
        const { runtime, thread } = yield* Fiber.join(recovery);
        const recovered = yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.length === 2,
          ),
          Stream.runCollect,
        );
        assert.sameMembers(
          recovered.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
              ? [event.turnItem.nativeItemRef?.nativeId]
              : [],
          ),
          ids,
        );
        if (failure === "timeout") {
          gate.release("recovery-pending");
          yield* Effect.promise(() => gate.waitForReached("polled"));
          gate.release("polled");
        }
        const watch = yield* watchBackgroundTurn(runtime);
        yield* runtime.startTurn(withLineage(thread));
        yield* watch.attached;
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* watch.terminal)?.status, "interrupted");
        assert.equal(
          yield* runtime.hasPendingBackgroundWorkForThread!(thread),
          failure === "remove",
        );
        if (failure === "remove")
          yield* runtime.stopTask!({ providerThread: thread, taskId: ids[0]! });
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      }),
  );

  it.effect("keeps background subagents running when a turn is interrupted to restart it", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
      ]);
      const watch = yield* watchBackgroundTurn(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.attached;
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      assert.equal((yield* watch.terminal)?.status, "interrupted");
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
    }),
  );

  it.effect("stops background subagents on a user Stop", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        out("session.interrupt", { sessionID: CHILD }),
        reply("session.interrupt", { interrupted: true }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
      ]);
      const watch = yield* watchBackgroundTurn(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.attached;
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      assert.equal((yield* watch.terminal)?.status, "interrupted");
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    }),
  );

  it.effect("gives a background subagent the rules of a mode changed while it runs", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("agent.list", "<any>"),
        reply("agent.list", agentList),
        out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
        reply("session.update", null),
        out("session.update", {
          sessionID: CHILD,
          permissions: [...supervisedRules.slice(0, 3), ...mcpRules],
        }),
        reply("session.update", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const firstEnded = yield* Deferred.make<void>();
      const ended = yield* runtime.events.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.tap(() => Deferred.succeed(firstEnded, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(firstEnded);
      yield* runtime.startTurn({
        ...withLineage(thread),
        runId: RunId.make("run:opencode2-adapter:2"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
        runtimePolicy: policy("approval-required"),
      });
      assert.deepEqual(
        [...(yield* Fiber.join(ended))].map((terminal) => terminal.status),
        ["completed", "completed"],
      );
    }),
  );

  it.effect(
    "keeps a finished background subagent's queued report pending until its native continuation ends",
    () =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["continue"]);
        const { runtime, thread } = yield* resumed(
          [
            ...nestedLaunch,
            event("session.execution.succeeded", { sessionID: DEEP }),
            deepReport("completed"),
            event("session.model.selected", {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "big-pickle", variant: "thinking" },
            }),
            event("session.execution.started", { sessionID: MIDDLE }, "continue"),
            event("session.inbox.delivered", { sessionID: MIDDLE, inboxID: "msg_deep_report" }),
            event("session.text.ended", {
              sessionID: MIDDLE,
              assistantMessageID: "msg_native_continuation",
              ordinal: 0,
              text: "GRANDCHILD_OK",
            }),
            event("session.execution.succeeded", { sessionID: MIDDLE }),
            event("session.model.selected", {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "big-pickle", variant: "none" },
            }),
          ],
          { replayGate: gate },
        );
        const queued = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const timeline: Array<boolean | string> = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "provider_thread.updated") {
                if (
                  event.providerThread.nativeThreadRef?.nativeId === MIDDLE &&
                  event.pendingBackgroundWork !== undefined
                ) {
                  timeline.push(event.pendingBackgroundWork);
                }
                if (event.providerThread.id === thread.id) {
                  const variant =
                    event.providerThread.nativeMetadata?.modelSelection?.options?.[0]?.value;
                  if (variant === "thinking") yield* Deferred.succeed(queued, undefined);
                  if (variant === "none") yield* Deferred.succeed(drained, undefined);
                }
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === `${MIDDLE}:turn:2`
              ) {
                timeline.push(event.providerTurn.status);
              }
              if (event.type === "message.updated" && event.message.text === "GRANDCHILD_OK") {
                timeline.push(event.message.text);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(queued);
        assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
        assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.strictEqual(timeline.at(-1), true);
        timeline.length = 0;
        gate.release("continue");
        yield* Deferred.await(drained);
        assert.deepEqual(
          timeline.filter((entry) => typeof entry === "string"),
          ["running", "GRANDCHILD_OK", "completed"],
        );
        assert.isAbove(timeline.indexOf(false), timeline.indexOf("completed"));
        assert.strictEqual(timeline.at(-1), false);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      }),
  );

  const returnedRunning = (id: string): ProviderReplayEntry => ({
    type: "emit_inbound",
    frame: {
      type: "sdk.event",
      event: {
        id: `evt_toolsuccess_${id}`,
        created: 1,
        type: "session.tool.success",
        data: {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant",
          id,
          content: [{ type: "text", text: "The subagent is working in the background." }],
          metadata: { sessionID: CHILD, status: "running" },
          executed: true,
        },
        durable: { aggregateID: SESSION, seq: 1, version: 2 },
      },
    },
  });
  const callAgain = (
    input: Record<string, unknown>,
    { id = "call-again", writesRules = true } = {},
  ): ReadonlyArray<ProviderReplayEntry> => {
    const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id };
    return [
      event("session.tool.input.started", { ...tool, name: "subagent" }),
      event("session.tool.called", {
        ...tool,
        name: "subagent",
        input: { description: "Again", prompt: "also this", sessionID: CHILD, ...input },
        executed: false,
      }),
      event("session.tool.progress", {
        ...tool,
        metadata: { sessionID: CHILD, status: "running" },
      }),
      // The adapter writes a child's rules only when they changed.
      ...(writesRules
        ? [
            out("session.update", { sessionID: CHILD, permissions: "<any>" }),
            reply("session.update", null),
          ]
        : []),
      returnedRunning(tool.id),
    ];
  };
  const childReport = (inboxID: string, text: string, description = "Sleep") =>
    event("session.inbox.enqueued", {
      inboxID,
      sessionID: SESSION,
      item: {
        type: "synthetic",
        payload: {
          text: `<subagent sessionID="${CHILD}" state="completed" description="${description}">\n${text}\n</subagent>`,
          description,
          metadata: { source: "subagent", childID: CHILD, agent: "General", state: "completed" },
        },
        delivery: "steer",
      },
    });
  const watchCalls = (
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    thread: OrchestrationV2ProviderThread,
  ) =>
    Effect.gen(function* () {
      const calls = new Map<string, { status: string; result: string | null }>();
      const callsById = new Map<string, { status: string; result: string | null }>();
      const childTurns = new Map<string, string>();
      const callsAtChildTurnStart = new Map<
        string,
        Record<string, { status: string; result: string | null }>
      >();
      const state: { roster: ReadonlyArray<unknown> | undefined } = { roster: undefined };
      let wake = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "subagent.updated") {
              callsById.set(event.subagent.nativeTaskRef?.nativeId ?? "", {
                status: event.subagent.status,
                result: event.subagent.result,
              });
            }
            if (event.type === "subagent.updated" && event.subagent.title !== null) {
              calls.set(event.subagent.title, {
                status: event.subagent.status,
                result: event.subagent.result,
              });
            }
            if (event.type === "provider_thread.updated" && event.providerThread.id === thread.id) {
              state.roster = event.providerThread.pendingBackgroundTasks;
            }
            const id =
              event.type === "provider_turn.updated"
                ? event.providerTurn.nativeTurnRef?.nativeId
                : undefined;
            if (
              event.type === "provider_turn.updated" &&
              id?.startsWith(`${CHILD}:turn:`) === true
            ) {
              if (!childTurns.has(id)) {
                callsAtChildTurnStart.set(id, Object.fromEntries(calls));
              }
              childTurns.set(id, event.providerTurn.status);
            }
            yield* Deferred.succeed(wake, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const until = (check: () => boolean): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (check()) return Effect.void;
          return Effect.gen(function* () {
            wake = yield* Deferred.make<void>();
            if (check()) return;
            yield* Deferred.await(wake);
            yield* until(check);
          });
        });
      return { calls, callsById, callsAtChildTurnStart, childTurns, state, until };
    });
  const launchedAndRunning = [
    ...backgroundLaunch(CHILD),
    returnedRunning("call-background"),
    event("session.execution.started", { sessionID: CHILD }),
  ];

  it.effect.each([false, true])(
    "settles a failed background subagent with recovered child=%s",
    (recoveredChild) =>
      Effect.gen(function* () {
        const ids = yield* IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer));
        const childThreadId = ids.derive.subagentThread({
          driver: OPENCODE_PROVIDER,
          nativeThreadId: CHILD,
          providerInstanceId: instanceId,
        });
        const childProviderThread = {
          ...providerThread(yield* DateTime.now),
          id: ids.derive.providerThread({
            driver: OPENCODE_PROVIDER,
            nativeThreadId: CHILD,
            providerInstanceId: instanceId,
          }),
          appThreadId: childThreadId,
          nativeThreadRef: {
            driver: OPENCODE_PROVIDER,
            nativeId: CHILD,
            strength: "strong" as const,
          },
        };
        const shell = {
          id: "sh_old_child",
          command: "echo done",
          status: "exited",
          exit: 0,
          cwd: WORK,
          shell: "/bin/sh",
          file: "/remote/output",
          metadata: { sessionID: CHILD },
          time: { started: 1, completed: 2 },
        };
        const response = (data: unknown) => ({ location: { directory: WORK }, data });
        const { runtime, thread } = yield* resumed(
          [
            ...(recoveredChild
              ? [
                  out("session.get", { sessionID: CHILD }),
                  replyData("session.get", sessionInfo({ id: CHILD })),
                  out("permission.list", { sessionID: CHILD }),
                  replyData("permission.list", []),
                  out("session.form.list", { sessionID: CHILD }),
                  replyData("session.form.list", []),
                  out("shell.list", "<any>"),
                  reply("shell.list", response([shell])),
                  out("shell.get", { id: shell.id }),
                  reply("shell.get", response(shell)),
                  out("shell.output", { id: shell.id }),
                  reply(
                    "shell.output",
                    response({ output: "done", cursor: 4, size: 4, truncated: false }),
                  ),
                  out("session.update", { sessionID: CHILD, permissions: "<any>" }),
                  reply("session.update", null),
                ]
              : []),
            ...launchedAndRunning,
            // The parent turn ends, and the background child fails: it reports
            // nothing back, so its call has to end with the failure.
            event("session.execution.succeeded", { sessionID: SESSION }),
            event("session.execution.failed", {
              sessionID: CHILD,
              error: { type: "provider.quota", message: "Rate limit exceeded." },
            }),
          ],
          recoveredChild ? { version: "2.2.1" } : undefined,
        );
        if (recoveredChild)
          yield* runtime.resumeThread({
            providerThread: childProviderThread,
            threadId: childThreadId,
            modelSelection: bigPickle,
            runtimePolicy: policy(),
          });
        const childUpdates: Array<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
        > = [];
        const watch = yield* watchCalls(
          {
            ...runtime,
            events: runtime.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.id === childProviderThread.id &&
                    event.providerThread.ownerNodeId !== null
                  )
                    childUpdates.push(event);
                }),
              ),
            ),
          },
          thread,
        );
        yield* runtime.startTurn(withLineage(thread));
        yield* watch.until(
          () => watch.calls.get("Sleep")?.status === "failed" && watch.state.roster?.length === 0,
        );
        assert.includeMembers(
          childUpdates.map((event) => event.providerThread.status),
          ["active", "idle"],
        );
        assert.isFalse(
          childUpdates.some((event) => event.sessionScoped === true),
          "reattached child status must route through the parent run",
        );
        assert.deepEqual(watch.state.roster, []);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      }),
  );

  // regression: #21979 a failed background subagent pinned its thread as busy
  it.effect("settles the background call a foreground call joined to a failed child", () =>
    Effect.gen(function* () {
      const again = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-again" };
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        // A foreground call joins the running background child. It is only
        // marked background once its own tool call returns, so the child can
        // fail while this call is still the foreground one.
        event("session.tool.input.started", { ...again, name: "subagent" }),
        event("session.tool.called", {
          ...again,
          name: "subagent",
          input: { description: "Again", prompt: "also this", sessionID: CHILD },
          executed: false,
        }),
        event("session.tool.progress", {
          ...again,
          metadata: { sessionID: CHILD, status: "running" },
        }),
        out("session.update", { sessionID: CHILD, permissions: "<any>" }),
        reply("session.update", null),
        // The child fails while the joined call is still the foreground one.
        event("session.execution.failed", {
          sessionID: CHILD,
          error: { type: "provider.quota", message: "Rate limit exceeded." },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () =>
          watch.calls.get("Sleep")?.status === "failed" &&
          watch.calls.get("Again")?.status === "failed" &&
          watch.state.roster?.length === 0,
      );
      assert.deepEqual(watch.state.roster, []);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }),
  );

  it.effect("settles every call that joined a running subagent with its one report", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        ...callAgain({ background: true }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        childReport("msg_report", "CHILD_OK"),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () =>
          watch.calls.get("Again")?.status === "completed" &&
          watch.calls.get("Sleep")?.status === "completed" &&
          watch.state.roster?.length === 0,
      );
      assert.deepEqual(Object.fromEntries(watch.calls), {
        Sleep: { status: "completed", result: "CHILD_OK" },
        Again: { status: "completed", result: "CHILD_OK" },
      });
    }),
  );

  it.effect("keeps a call to a finished subagent for its own run's report", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...launchedAndRunning,
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...callAgain({ background: true }),
        childReport("msg_report_1", "FIRST_OK"),
        event("session.execution.started", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        childReport("msg_report_2", "SECOND_OK"),
      ]);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.childTurns.has(`${CHILD}:turn:2`));
      assert.deepEqual(watch.callsAtChildTurnStart.get(`${CHILD}:turn:2`), {
        Sleep: { status: "completed", result: "FIRST_OK" },
        Again: { status: "running", result: null },
      });
      yield* watch.until(() => watch.calls.get("Again")?.status === "completed");
      assert.deepEqual(watch.calls.get("Again"), { status: "completed", result: "SECOND_OK" });
    }),
  );

  const childSaid = (text: string, run = 1) =>
    event("session.text.ended", {
      sessionID: CHILD,
      assistantMessageID: `msg_child_${run}`,
      ordinal: 0,
      text,
    });
  it.effect.each([
    {
      // regression: #26319 the report settled the older run and left the resumed call running
      name: "an earlier run's report never arrived",
      replay: [
        ...launchedAndRunning,
        ...callAgain({ background: true }),
        childSaid("FIRST_OK"),
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...callAgain({ background: true }, { id: "call-later", writesRules: false }),
        event("session.execution.started", { sessionID: CHILD }),
        childSaid("SECOND_OK", 2),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        childReport("msg_report_2", "SECOND_OK", "Again"),
      ],
      expected: {
        "call-background": { status: "completed", result: "FIRST_OK" },
        "call-again": { status: "completed", result: "FIRST_OK" },
        "call-later": { status: "completed", result: "SECOND_OK" },
      },
    },
    {
      name: "both runs' reports arrive after the runs ended",
      replay: [
        ...launchedAndRunning,
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...callAgain({ background: true, description: "Sleep" }),
        event("session.execution.started", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        childReport("msg_report_1", "FIRST_OK"),
        childReport("msg_report_2", "SECOND_OK"),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ],
      expected: {
        "call-background": { status: "completed", result: "FIRST_OK" },
        "call-again": { status: "completed", result: "SECOND_OK" },
      },
    },
    {
      name: "two runs with the same answer report late",
      replay: [
        ...launchedAndRunning,
        childSaid("DONE"),
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...callAgain({ background: true }),
        event("session.execution.started", { sessionID: CHILD }),
        childSaid("DONE", 2),
        event("session.execution.succeeded", { sessionID: CHILD }),
        childReport("msg_report_1", "DONE"),
        ...callAgain({ background: true }, { id: "call-later", writesRules: false }),
        event("session.execution.started", { sessionID: CHILD }),
        childReport("msg_report_2", "DONE", "Again"),
        childSaid("THIRD_OK", 3),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        childReport("msg_report_3", "THIRD_OK", "Again"),
      ],
      expected: {
        "call-background": { status: "completed", result: "DONE" },
        "call-again": { status: "completed", result: "DONE" },
        "call-later": { status: "completed", result: "THIRD_OK" },
      },
    },
    {
      name: "the call it joined already returned",
      replay: [
        ...backgroundLaunch(CHILD),
        event("session.execution.started", { sessionID: CHILD }),
        ...callAgain({ background: true }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event(
          "session.tool.success",
          {
            sessionID: SESSION,
            assistantMessageID: "msg_assistant",
            id: "call-background",
            content: [{ type: "text", text: "FIRST_OK" }],
            metadata: { sessionID: CHILD, status: "completed" },
            executed: true,
          },
          undefined,
          2,
        ),
        event("session.execution.succeeded", { sessionID: SESSION }),
        childReport("msg_report", "CHILD_OK", "Again"),
      ],
      expected: {
        "call-background": { status: "completed", result: "FIRST_OK" },
        "call-again": { status: "completed", result: "CHILD_OK" },
      },
    },
  ])("settles a resumed subagent's calls when $name", ({ replay, expected }) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(replay);
      const watch = yield* watchCalls(runtime, thread);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(
        () =>
          watch.state.roster?.length === 0 &&
          Object.keys(expected).every((id) => watch.callsById.get(id)?.status === "completed"),
      );
      assert.deepEqual(Object.fromEntries(watch.callsById), expected);
    }),
  );

  const MIDDLE = "ses_middle0000000000000000000";
  const DEEP = "ses_grandchild00000000000000";
  const toolOf = (session: string, id: string) => ({
    sessionID: session,
    assistantMessageID: `msg_assistant_${id}`,
    id,
  });
  const deepReport = (state: "completed" | "cancelled") =>
    event("session.inbox.enqueued", {
      inboxID: "msg_deep_report",
      sessionID: MIDDLE,
      item: {
        type: "synthetic",
        payload: {
          text: `<subagent sessionID="${DEEP}" state="${state}" description="Deep">\nDEEP_OK\n</subagent>`,
          description: "Deep",
          metadata: { source: "subagent", childID: DEEP, agent: "General", state },
        },
        delivery: "steer",
      },
    });
  const nestedLaunch: ReadonlyArray<ProviderReplayEntry> = [
    out("session.prompt", { sessionID: SESSION, text: "<any>" }),
    promptAccepted,
    event("session.execution.started", { sessionID: SESSION }),
    event("session.tool.input.started", { ...toolOf(SESSION, "call-middle"), name: "subagent" }),
    event("session.tool.called", {
      ...toolOf(SESSION, "call-middle"),
      name: "subagent",
      input: { description: "Middle", prompt: "delegate" },
      executed: false,
    }),
    event("session.created", { ...childCreated(MIDDLE), title: "Middle" }),
    event("session.tool.progress", {
      ...toolOf(SESSION, "call-middle"),
      metadata: { sessionID: MIDDLE, status: "running" },
    }),
    event("session.execution.started", { sessionID: MIDDLE }),
    event("session.tool.input.started", { ...toolOf(MIDDLE, "call-deep"), name: "subagent" }),
    event("session.tool.called", {
      ...toolOf(MIDDLE, "call-deep"),
      name: "subagent",
      input: { description: "Deep", prompt: "sleep", background: true },
      executed: false,
    }),
    event("session.created", { ...childCreated(DEEP), parentID: MIDDLE, title: "Deep" }),
    event("session.tool.progress", {
      ...toolOf(MIDDLE, "call-deep"),
      metadata: { sessionID: DEEP, status: "running" },
    }),
    event("session.tool.success", {
      ...toolOf(MIDDLE, "call-deep"),
      content: [{ type: "text", text: "The subagent is working in the background." }],
      metadata: { sessionID: DEEP, status: "running", truncated: false },
      executed: false,
    }),
    event("session.execution.started", { sessionID: DEEP }),
    event("session.execution.succeeded", { sessionID: MIDDLE }),
    event("session.tool.success", {
      ...toolOf(SESSION, "call-middle"),
      content: [{ type: "text", text: `<subagent sessionID="${MIDDLE}" state="completed">` }],
      metadata: { sessionID: MIDDLE, status: "completed", truncated: false },
      executed: false,
    }),
    event("session.execution.succeeded", { sessionID: SESSION }),
  ];
  const watchNested = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
    Effect.gen(function* () {
      const deep: Array<string> = [];
      const middleTurns = new Map<string, string>();
      const pendingSnapshots = new Map<string, boolean>();
      const variants = new Map<string, unknown>();
      let rootVariant: unknown;
      const terminals: Array<string> = [];
      const changed = yield* Deferred.make<void>();
      let wake = changed;
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "turn.terminal") terminals.push(event.status);
            if (event.type === "provider_thread.updated") {
              const nativeId = event.providerThread.nativeThreadRef?.nativeId;
              if (nativeId != null && event.pendingBackgroundWork !== undefined) {
                pendingSnapshots.set(nativeId, event.pendingBackgroundWork);
              }
              const variant =
                event.providerThread.nativeMetadata?.modelSelection?.options?.[0]?.value;
              if (nativeId != null) variants.set(nativeId, variant);
              if (nativeId === SESSION) rootVariant = variant;
            }
            if (event.type === "subagent.updated" && event.subagent.title === "Deep") {
              deep.push(event.subagent.status);
            }
            const native = event.type === "provider_turn.updated" ? event.providerTurn : undefined;
            const id = native?.nativeTurnRef?.nativeId;
            if (native !== undefined && id?.startsWith(`${MIDDLE}:turn:`) === true) {
              middleTurns.set(id, native.status);
            }
            yield* Deferred.succeed(wake, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      const until = (check: () => boolean): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (check()) return Effect.void;
          return Effect.gen(function* () {
            wake = yield* Deferred.make<void>();
            if (check()) return;
            yield* Deferred.await(wake);
            yield* until(check);
          });
        });
      return {
        deep,
        middleTurns,
        terminals,
        pendingSnapshots,
        variants,
        get rootVariant() {
          return rootVariant;
        },
        until,
      };
    });

  it.effect("clears a nested report cancelled during a held wake", () =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["drained"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          childReport("msg_report", "CHILD_OK"),
          event("session.execution.started", { sessionID: SESSION }),
          ...nestedLaunch.slice(3, -2),
          event(
            "session.tool.success",
            {
              ...toolOf(SESSION, "call-middle"),
              content: [{ type: "text", text: "MIDDLE_OK" }],
              metadata: { sessionID: MIDDLE, status: "completed", truncated: false },
              executed: false,
            },
            undefined,
            2,
          ),
          event("session.execution.succeeded", { sessionID: DEEP }),
          deepReport("completed"),
          event("session.inbox.cancelled", { sessionID: MIDDLE, inboxID: "msg_deep_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "big-pickle", variant: "thinking" },
          }),
          event(
            "session.model.selected",
            {
              sessionID: SESSION,
              model: { providerID: "opencode", id: "big-pickle", variant: "none" },
            },
            "drained",
          ),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => {
              offers.push(request);
            }),
          take: Effect.never,
        }),
      );
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("drained")));
      yield* watch.until(() => watch.rootVariant === "thinking");
      assert.lengthOf(offers, 1);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      gate.release("drained");
      yield* watch.until(() => watch.rootVariant === "none");
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      assert.strictEqual(watch.pendingSnapshots.get(MIDDLE), false);
    }),
  );

  it.effect("clears the caller's pending work when a called session's held wake runs", () =>
    Effect.gen(function* () {
      const OTHER = "ses_other00000000000000000000";
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["drained"]);
      const { runtime, thread } = yield* resumed(
        [
          out("session.get", { sessionID: OTHER }),
          replyData("session.get", sessionInfo({ id: OTHER })),
          out("permission.list", { sessionID: OTHER }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: OTHER }),
          replyData("session.form.list", []),
          event("session.execution.started", { sessionID: OTHER }),
          event("session.execution.succeeded", { sessionID: OTHER }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.tool.input.started", {
            ...toolOf(SESSION, "call-other"),
            name: "subagent",
          }),
          event("session.tool.called", {
            ...toolOf(SESSION, "call-other"),
            name: "subagent",
            input: { description: "Other", prompt: "again" },
            executed: false,
          }),
          event("session.tool.progress", {
            ...toolOf(SESSION, "call-other"),
            metadata: { sessionID: OTHER, status: "running" },
          }),
          event("session.tool.success", {
            ...toolOf(SESSION, "call-other"),
            content: [{ type: "text", text: "OTHER_OK" }],
            metadata: { sessionID: OTHER, status: "completed", truncated: false },
            executed: false,
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event(
            "session.model.selected",
            {
              sessionID: OTHER,
              model: { providerID: "opencode", id: "big-pickle", variant: "none" },
            },
            "drained",
          ),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => {
              offers.push(request);
            }),
          take: Effect.never,
        }),
      );
      const other = yield* runtime.resumeThread({
        providerThread: {
          ...thread,
          id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
          nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: OTHER, strength: "strong" },
        },
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const watch = yield* watchNested(runtime);
      yield* watch.until(() => offers.length === 1);
      yield* runtime.startTurn(withLineage(thread));
      assert.isTrue(yield* Effect.promise(() => gate.waitForReached("drained")));
      // The called session's held wake is its caller's pending work too.
      yield* watch.until(() => watch.pendingSnapshots.get(SESSION) === true);
      yield* runtime.startTurn(continuationTurn(other, offers[0]!));
      gate.release("drained");
      yield* watch.until(() => watch.variants.get(OTHER) === "none");
      assert.isFalse(watch.pendingSnapshots.get(OTHER));
      assert.isFalse(watch.pendingSnapshots.get(SESSION));
    }),
  );

  it.effect("stops a foreground subagent's background subagent after the turn ended", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...nestedLaunch,
        out("session.interrupt", { sessionID: DEEP }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: DEEP }),
        deepReport("cancelled"),
        event("session.execution.started", { sessionID: MIDDLE }),
        out("session.interrupt", { sessionID: MIDDLE }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: MIDDLE }),
        event("session.execution.started", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.terminals.length > 0);
      assert.deepEqual(watch.terminals, ["completed"]);
      assert.equal(watch.deep.at(-1), "running");
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Deferred.await(offered);
      assert.equal(watch.deep.at(-1), "interrupted");
      assert.deepEqual([...watch.middleTurns.keys()], [`${MIDDLE}:turn:1`]);
    }),
  );

  it.effect("stops the turn a foreground subagent runs to answer its background subagent", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        ...nestedLaunch,
        event("session.execution.succeeded", { sessionID: DEEP }),
        deepReport("completed"),
        event("session.execution.started", { sessionID: MIDDLE }),
        event("session.text.ended", {
          sessionID: MIDDLE,
          assistantMessageID: "msg_assistant_answer",
          ordinal: 0,
          text: "Noted.",
        }),
        out("session.interrupt", { sessionID: MIDDLE }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: MIDDLE }),
      ]);
      const watch = yield* watchNested(runtime);
      yield* runtime.startTurn(withLineage(thread));
      yield* watch.until(() => watch.middleTurns.get(`${MIDDLE}:turn:2`) === "running");
      assert.equal(watch.deep.at(-1), "completed");
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* watch.until(() => watch.middleTurns.get(`${MIDDLE}:turn:2`) === "interrupted");
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }),
  );

  const stopTimedOut: ReadonlyArray<ProviderReplayEntry> = [
    out("session.prompt", { sessionID: SESSION, text: "<any>" }),
    promptAccepted,
    out("session.interrupt", { sessionID: SESSION }),
    reply("session.interrupt", "<hang>"),
  ];
  const secondTurn = (thread: OrchestrationV2ProviderThread) => ({
    ...turnInput(thread),
    runId: RunId.make("run:opencode2-adapter:2"),
    runOrdinal: 2,
    providerTurnOrdinal: 2,
    attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
  });
  const stopFirstTurn = (
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    thread: OrchestrationV2ProviderThread,
  ) =>
    Effect.gen(function* () {
      yield* runtime.startTurn(turnInput(thread));
      const interrupt = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(interrupt).pipe(Effect.flip);
    });
  const terminals = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, count: number) =>
    runtime.events.pipe(
      Stream.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      ),
      Stream.take(count),
      Stream.runCollect,
      Effect.forkScoped,
    );

  // regression: #30193 an unanswered Stop showed the turn interrupted while its tool kept running
  it.effect("reports a Stop OpenCode never answers as an interrupt timeout", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(stopTimedOut);
      yield* runtime.startTurn(turnInput(thread));
      const interrupt = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      const exit = yield* Fiber.join(interrupt);
      assert.propertyVal(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : { _tag: "interrupt succeeded" },
        "_tag",
        "ProviderAdapterInterruptTimeoutError",
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("never lets a timed-out Stop's late end finish the next turn", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["late-end"]);
      const { runtime, thread } = yield* resumed(
        [
          ...stopTimedOut,
          event("session.execution.succeeded", { sessionID: SESSION }, "late-end"),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.execution.failed", {
            sessionID: SESSION,
            error: { type: "provider", message: "second turn failed" },
          }),
        ],
        { replayGate: gate },
      );
      const lateEnd = yield* Deferred.make<void>();
      const ended = yield* runtime.events.pipe(
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.tap(() => Deferred.succeed(lateEnd, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* stopFirstTurn(runtime, thread);
      gate.release("late-end");
      yield* Deferred.await(lateEnd);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "interrupted");
      assert.equal(second?.status, "failed");
      assert.equal(second?.failure?.message, "second turn failed");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("checks the server before prompting again after a prompt request failed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 502,
          body: { _tag: "UnknownError", message: "bad gateway" },
        }),
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "failed");
      assert.equal(second?.failure?.message, OPENCODE_2_STILL_STOPPING);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  // regression: #14744 continuations hung after a reconnect took a Stop's end
  it.effect("still checks the server when a failed prompt's execution starts late", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 502,
          body: { _tag: "UnknownError", message: "bad gateway" },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      yield* Deferred.await(offered);
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "failed");
      assert.equal(second?.failure?.message, OPENCODE_2_STILL_STOPPING);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("ends a background reply's continuation after a lost stream took a Stop's end", () =>
    Effect.gen(function* () {
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const gate = makeProviderReplayGate(["drop", "reply"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", "<hang>"),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          event("session.usage.updated", { sessionID: SESSION }, "drop"),
          { type: "runtime_exit", status: "success" } as const,
          out("event.subscribe"),
          out("session.active"),
          replyData("session.active", { [CHILD]: { type: "running" } }),
          out("message.list", "<any>"),
          reply("message.list", { data: [], cursor: {} }),
          out("permission.list", { sessionID: CHILD }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: CHILD }),
          replyData("session.form.list", []),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event(
            "session.text.ended",
            {
              sessionID: SESSION,
              assistantMessageID: "msg_followup",
              ordinal: 0,
              text: "CHILD_OK",
            },
            "reply",
          ),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.started", { sessionID: CHILD }),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const attached = yield* Deferred.make<void>();
      const collected = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "subagent.updated" && event.subagent.childThreadId !== null
            ? Deferred.succeed(attached, undefined)
            : Effect.void,
        ),
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId?.startsWith(`${CHILD}:turn:`) === true,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(attached);
      const stop = { providerThread: thread, providerTurnId: yield* providerTurnId };
      const interrupt = yield* runtime.interruptTurn(stop).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(interrupt);
      yield* runtime.interruptTurn(stop);
      gate.release("drop");
      yield* runtime.startTurn({
        ...continuationTurn(thread, yield* Deferred.await(offered)),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
      });
      gate.release("reply");
      const events = [...(yield* Fiber.join(collected))];
      assert.deepEqual(
        events.flatMap((event) => (event.type === "turn.terminal" ? [event.status] : [])),
        ["interrupted", "completed"],
      );
      assert.include(
        events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        ),
        "CHILD_OK",
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  const replyAfterUnclearFailure = (endedFirst: boolean) =>
    Effect.gen(function* () {
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const gate = makeProviderReplayGate(endedFirst ? ["wake"] : ["wake", "reply"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("session.update", { sessionID: CHILD, permissions: t3Rules }),
          reply("session.update", null),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          reply("session.prompt", {
            status: 502,
            body: { _tag: "UnknownError", message: "bad gateway" },
          }),
          event("session.execution.succeeded", { sessionID: CHILD }, "wake"),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event(
            "session.text.ended",
            {
              sessionID: SESSION,
              assistantMessageID: "msg_followup",
              ordinal: 0,
              text: "CHILD_OK",
            },
            endedFirst ? undefined : "reply",
          ),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.started", { sessionID: CHILD }),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      const launched = yield* Deferred.make<void>();
      const childRan = yield* Deferred.make<void>();
      const ended: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const allEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId?.startsWith(`${CHILD}:turn:`) === true
            ) {
              yield* Deferred.succeed(childRan, undefined);
            }
            if (event.type !== "turn_item.updated" && event.type !== "turn.terminal") return;
            ended.push(event);
            if (event.type === "turn.terminal") yield* Deferred.succeed(launched, undefined);
            if (ended.filter((entry) => entry.type === "turn.terminal").length === 3) {
              yield* Deferred.succeed(allEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(launched);
      yield* runtime
        .startTurn({ ...secondTurn(thread), appThread: withLineage(thread).appThread })
        .pipe(Effect.ignore);
      gate.release("wake");
      if (endedFirst) yield* Deferred.await(childRan);
      yield* runtime.startTurn({
        ...continuationTurn(thread, yield* Deferred.await(offered)),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
      });
      if (!endedFirst) gate.release("reply");
      yield* Deferred.await(allEnded);
      assert.deepEqual(
        ended.flatMap((event) => (event.type === "turn.terminal" ? [event.status] : [])),
        ["completed", "failed", "completed"],
      );
      assert.include(
        ended.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        ),
        "CHILD_OK",
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

  // regression: #14744 continuations hung after a reconnect took a Stop's end
  it.effect("ends a background reply's continuation after a prompt failed unclearly", () =>
    replyAfterUnclearFailure(false),
  );

  it.effect("reports a turn as completed when its Stop request failed", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", {
          status: 500,
          body: { _tag: "UnknownError", message: "interrupt failed" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const failed = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.flip);
      assert.equal(failed._tag, "ProviderAdapterInterruptError");
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("gives a resumed session T3's rules when it was made with others", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData(
          "session.get",
          sessionInfo({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "subagent", resource: "*", effect: "deny" },
            ],
          }),
        ),
        ...noOpenRequests,
        out("session.update", { sessionID: SESSION, permissions: t3Rules }),
        reply("session.update", null),
      ]);
      yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
    }),
  );

  it.effect("moves the session when the thread's worktree changed", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        ...directoryModels("/work/opencode2-feature"),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        out("session.move", { sessionID: SESSION, directory: "/work/opencode2-feature" }),
        reply("session.move", null),
      ]);
      yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: { ...policy(), cwd: "/work/opencode2-feature" },
      });
    }),
  );

  it.effect("breaks the thread and forgets it when the session was deleted outside T3", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 404,
          body: {
            _tag: "SessionNotFoundError",
            sessionID: SESSION,
            message: `Session not found: ${SESSION}`,
          },
        }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(ended?.threadDisposition, "broken");
      const again = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.flip);
      assert.equal(again._tag, "ProviderAdapterProtocolError");
      assert.include(again.message, "not registered");
    }),
  );

  it.effect("stops the requests a session still waits on when a restarted T3 loads it", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions(
        [
          ...opening,
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          out("permission.list", { sessionID: SESSION }),
          replyData("permission.list", [shellAsk.data]),
          out("session.form.list", { sessionID: SESSION }),
          replyData("session.form.list", [colorForm]),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "reject",
          }),
          reply("permission.reply", null),
          out("session.form.cancel", { sessionID: SESSION, formID: colorForm.id }),
          reply("session.form.cancel", null),
          out("session.active"),
          reply("session.active", { data: {} }),
          event("session.execution.interrupted", { sessionID: SESSION, reason: "user" }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { external: true },
      );
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("ends the turn when an answer to its request cannot be delivered", () =>
    Effect.gen(function* () {
      const failedReply = reply("permission.reply", {
        status: 500,
        body: { _tag: "UnknownError", message: "reply failed" },
      });
      const replyOut = out("permission.reply", {
        sessionID: SESSION,
        requestID: shellAsk.data.id,
        decision: "once",
      });
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          replyOut,
          failedReply,
          replyOut,
          failedReply,
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(
        ended?.status === "failed" ? ended.failure.message : undefined,
        "OpenCode is waiting on a request T3 Code couldn't answer.",
      );
    }),
  );

  it.effect("counts an answer to a request OpenCode already dropped as delivered", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", {
            status: 404,
            body: {
              _tag: "PermissionNotFoundError",
              requestID: shellAsk.data.id,
              message: "Permission request not found",
            },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("declines a form T3 cannot show with the reason, instead of leaving it open", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("form.created", {
          form: {
            id: "frm_0eb79ab35001fkvFECSh3wYNVD",
            sessionID: SESSION,
            title: "MCP authorization",
            metadata: { kind: "mcp" },
            fields: [
              {
                key: "authorization",
                type: "external",
                url: "https://example.com/authorize",
                title: "Authorize",
              },
            ],
          },
        }),
        out("session.form.cancel", {
          sessionID: SESSION,
          formID: "frm_0eb79ab35001fkvFECSh3wYNVD",
        }),
        reply("session.form.cancel", null),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.include(
        ended?.status === "failed" ? ended.failure.message : "",
        "asked for a link to open",
      );
    }),
  );

  it.effect("asks a subagent's permission request on the parent thread's turn", () =>
    Effect.gen(function* () {
      const child = "ses_f0e5aa64cffelFnoQRL0DAA9BH";
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.created", {
            sessionID: child,
            slug: "stellar-garden",
            version: "2.0.18",
            projectID: "global",
            parentID: SESSION,
            location: { directory: WORK },
            subpath: "",
            title: "Echo test command",
            agent: "general",
            permissions: supervisedRules,
            model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          }),
          event("permission.asked", { ...shellAsk.data, sessionID: child }),
          out("permission.reply", {
            sessionID: child,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("permission.replied", {
            sessionID: child,
            requestID: shellAsk.data.id,
            reply: "once",
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      assert.equal(request?.nativeRequestRef?.nativeId, shellAsk.data.id);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("keeps 'allow this session' in the session's rules, not OpenCode's saved grants", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          out("session.update", {
            sessionID: SESSION,
            permissions: [
              ...supervisedRules.slice(0, 3),
              { action: "shell", resource: "echo *", effect: "allow" },
              ...supervisedRules.slice(3),
            ],
          }),
          reply("session.update", null),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({
        requestId: request!.id,
        decision: "acceptForSession",
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("reads the agents again while a fresh server still lists none", () =>
    Effect.gen(function* () {
      // OpenCode 2.0.18 briefly returns no agents on startup; using that response drops agent paths.
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("agent.list", "<any>"),
        reply("agent.list", { location: { directory: WORK }, data: [] }),
        out("agent.list", "<any>"),
        reply("agent.list", agentList),
        out("session.create", {
          location: { directory: WORK },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions: supervisedRules,
        }),
        replyData("session.create", sessionInfo({ permissions: supervisedRules })),
      ]);
      const created = yield* runtime
        .ensureThread({
          threadId,
          modelSelection: bigPickle,
          runtimePolicy: policy("approval-required"),
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* Fiber.join(created)).nativeThreadRef?.nativeId, SESSION);
    }),
  );
  const reconnected = (
    active: Record<string, unknown>,
    ended?: "succeeded",
    assistant: Record<string, unknown> = {},
    deliveredSteer?: string,
  ) => [
    { type: "runtime_exit", status: "success" } as const,
    out("event.subscribe"),
    out("session.active"),
    replyData("session.active", active),
    out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
    reply("message.list", {
      data: [
        ...(ended === undefined
          ? []
          : [{ id: "msg_idle_gap", time: { created: 3 }, type: "idle", outcome: ended }]),
        {
          id: "msg_assistant_gap",
          time: { created: 2 },
          type: "assistant",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          content: [
            { type: "text", text: "Sent while the stream was down." },
            {
              type: "tool",
              id: "call_gap",
              name: "shell",
              executed: true,
              state: {
                status: "completed",
                input: { command: "echo GAP" },
                content: [{ type: "text", text: "GAP" }],
                metadata: {},
              },
              time: { created: 2, ran: 2, completed: 2 },
            },
          ],
          finish: "stop",
          ...assistant,
        },
        ...(deliveredSteer === undefined
          ? []
          : [{ id: deliveredSteer, time: { created: 2 }, text: "steered", type: "user" }]),
        {
          id: "msg_0eb735d41001NJee1EvVePJAK5",
          time: { created: 1 },
          text: "hi",
          type: "user",
        },
      ],
      cursor: {},
    }),
  ];
  const openRequests = (
    permissions: ReadonlyArray<unknown>,
    forms: ReadonlyArray<unknown> = [],
  ): ReadonlyArray<ProviderReplayEntry> => [
    out("permission.list", { sessionID: SESSION }),
    replyData("permission.list", permissions),
    out("session.form.list", { sessionID: SESSION }),
    replyData("session.form.list", forms),
  ];

  const turnItems = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    collected.flatMap((event) =>
      event.type === "turn_item.updated" ? [`${event.turnItem.type}:${event.turnItem.status}`] : [],
    );

  it.effect.each(["delivered", "pending"] as const)(
    "reconciles a %s steer after reconnect without losing its execution",
    (delivery) =>
      Effect.gen(function* () {
        const steerId = `msg_t3_steer_${SESSION}:message:opencode2-adapter:steer`;
        const reconnect = reconnected(
          {},
          "succeeded",
          {},
          delivery === "delivered" ? steerId : undefined,
        );
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...(delivery === "pending"
              ? [
                  event("rpc.opencode.goal.changed", {
                    sessionID: SESSION,
                    goal: nativeGoal("active"),
                  }),
                ]
              : []),
            out("session.prompt", "<any>"),
            replyData("session.prompt", {
              id: steerId,
              sessionID: SESSION,
              time: { created: 2 },
              type: "user",
              payload: { text: "steered" },
              delivery: "steer",
            }),
            ...reconnect.slice(0, 2),
            ...(delivery === "pending"
              ? [out("rpc.call", "<any>"), reply("rpc.call", { output: { unreadable: true } })]
              : []),
            ...(delivery === "pending" ? emptyShellInventory : []),
            ...reconnect.slice(2),
            ...(delivery === "pending"
              ? [
                  event("session.execution.started", { sessionID: SESSION }),
                  event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_delayed_steer",
                    ordinal: 0,
                    text: "Steer processed",
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : [event("session.execution.interrupted", { sessionID: SESSION, reason: "user" })]),
          ],
          delivery === "pending" ? { version: "2.2.5" } : undefined,
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        yield* runtime.steerTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          threadId,
          runId: turnInput(thread).runId,
          message: {
            ...turnInput(thread).message,
            messageId: MessageId.make("message:opencode2-adapter:steer"),
            text: "steered",
          },
        });
        const collected = yield* Fiber.join(events);
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
        if (delivery === "pending")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Steer processed",
            ),
          );
      }),
  );

  it.effect("does not end a turn from an earlier turn's history when its prompt is not there", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        { type: "runtime_exit", status: "success" } as const,
        out("event.subscribe"),
        out("session.active"),
        replyData("session.active", {}),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_earlier", time: { created: 3 }, type: "idle", outcome: "succeeded" },
            {
              id: "msg_assistant_earlier",
              time: { created: 2 },
              type: "assistant",
              agent: "build",
              model: { id: "big-pickle", providerID: "opencode", variant: "default" },
              content: [{ type: "text", text: "An earlier turn's answer." }],
              finish: "stop",
            },
            { id: "msg_user_earlier", time: { created: 1 }, text: "earlier", type: "user" },
          ],
          cursor: {},
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      assert.notInclude(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem.text]
            : [],
        ),
        "An earlier turn's answer.",
      );
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "interrupted" });
    }),
  );

  it.effect("ends a turn that finished while the stream was down with the server's outcome", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        event("session.step.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          started: 1,
        }),
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        ...reconnected({}, "succeeded"),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      assert.includeMembers(turnItems(collected), [
        "assistant_message:completed",
        "command_execution:completed",
      ]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      // Steps that ended during the gap sent no tokens or models, so both stay incomplete.
      const settled = collected.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
      );
      const usage =
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined;
      assert.deepInclude(usage, { usageStatus: "partial", inputTokens: 100, outputTokens: 10 });
      assert.notProperty(usage, "models");
    }),
  );

  it.effect("finishes a workspace command whose stream dropped before its inbox event", () =>
    Effect.gen(function* () {
      // session.command returns 204 without an inbox id; the stream drops before session.inbox.enqueued provides it.
      const { runtime, thread } = yield* resumed([
        out("command.list", "<any>"),
        reply("command.list", { location: { directory: WORK }, data: [{ name: "git/hello" }] }),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_before", time: { created: 1 }, type: "idle", outcome: "succeeded" },
          ],
          cursor: {},
        }),
        out("session.command", { sessionID: SESSION, name: "git/hello", text: "WORLD" }),
        reply("session.command", null),
        { type: "runtime_exit", status: "success" } as const,
        out("event.subscribe"),
        out("session.active"),
        replyData("session.active", {}),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
        reply("message.list", {
          data: [
            { id: "msg_idle_cmd", time: { created: 4 }, type: "idle", outcome: "succeeded" },
            {
              id: "msg_assistant_cmd",
              time: { created: 3 },
              type: "assistant",
              agent: "build",
              model: { id: "big-pickle", providerID: "opencode", variant: "default" },
              content: [{ type: "text", text: "HELLO WORLD" }],
              finish: "stop",
            },
            {
              id: "msg_user_cmd",
              time: { created: 2 },
              text: "Reply with exactly: HELLO WORLD",
              type: "user",
            },
            { id: "msg_idle_before", time: { created: 1 }, type: "idle", outcome: "succeeded" },
          ],
          cursor: {},
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn({
        ...turnInput(thread),
        message: { ...turnInput(thread).message, text: "/git/hello WORLD" },
      });
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.include(texts, "HELLO WORLD");
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }),
  );

  it.effect("sends a $skill that appears once OpenCode finishes scanning the directory", () =>
    Effect.gen(function* () {
      const prompts: Array<unknown> = [];
      const greet = {
        id: "greet",
        name: "greet",
        path: `${WORK}/.opencode/skills/greet/SKILL.md`,
        content: "Say hello.",
      };
      const { runtime, thread } = yield* resumed(
        [
          out("skill.list", { "location[directory]": WORK }),
          reply("skill.list", { location: { directory: WORK }, data: [] }),
          // OpenCode answers the model list only once the directory scan has ended.
          ...directoryModels(WORK),
          out("skill.list", { "location[directory]": WORK }),
          reply("skill.list", { location: { directory: WORK }, data: [greet] }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { onPrompt: (input) => prompts.push(input) },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime
        .startTurn({
          ...turnInput(thread),
          message: { ...turnInput(thread).message, text: "$greet again please" },
        })
        .pipe(Effect.exit);
      assert.deepInclude(prompts[0], { skills: [{ id: "greet" }] });
      assert.isTrue(Exit.isSuccess(started));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("keeps owned work through a stalled reconciliation without releasing its server", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const borrowers = { current: 0 };
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          ...reconnected({ [SESSION]: { type: "running" } }),
          ...openRequests([]),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        {
          borrowers,
          beforeResponse: (path) =>
            path.endsWith("/message")
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
        },
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const ended = yield* runtime.events.pipe(
        Stream.tap((event) => Effect.sync(() => collected.push(event))),
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      yield* TestClock.adjust("3 minutes");
      assert.isFalse(collected.some((event) => event.type === "turn.terminal"));
      assert.equal(borrowers.current, 1);
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(ended);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }),
  );

  it.effect("reconciles a session deleted after the active snapshot", () =>
    Effect.gen(function* () {
      const otherId = "ses_other_stalled_session";
      const otherPrompt = "msg_other_stalled_prompt";
      const history = (sessionID: string, id: string) => [
        out("message.list", { sessionID, order: "desc", limit: "50" }),
        reply("message.list", {
          data: [{ id, time: { created: 1 }, text: "hi", type: "user" }],
          cursor: {},
        }),
      ];
      const requests = (sessionID: string) => [
        out("permission.list", { sessionID }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID }),
        replyData("session.form.list", []),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: otherId }),
        replyData("session.get", sessionInfo({ id: otherId })),
        ...requests(otherId),
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        out("session.instructions.entry.put", {
          sessionID: otherId,
          key: "t3-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        out("session.prompt", { sessionID: otherId, id: otherPrompt, text: "<any>" }),
        replyData("session.prompt", {
          id: otherPrompt,
          sessionID: otherId,
          time: { created: 1 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
        { type: "runtime_exit", status: "success" },
        out("event.subscribe"),
        out("session.active"),
        replyData("session.active", {
          [SESSION]: { type: "running" },
          [otherId]: { type: "running" },
        }),
        out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
        reply("message.list", {
          status: 404,
          body: {
            _tag: "SessionNotFoundError",
            sessionID: SESSION,
            message: "Deleted during recovery",
          },
        }),
        ...history(otherId, otherPrompt),
        ...requests(otherId),
        event("session.execution.succeeded", { sessionID: otherId }),
      ]);
      const other = yield* runtime.resumeThread({
        providerThread: {
          ...providerThread(yield* DateTime.now),
          id: ProviderThreadId.make("provider-thread:other"),
          nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: otherId, strength: "strong" },
        },
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminals = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.startTurn({
        ...turnInput(other),
        runId: RunId.make("run:other"),
        attemptId: RunAttemptId.make("attempt:other"),
      });
      const ended = yield* Fiber.join(terminals);
      assert.deepEqual(
        ended.map((event) => event.status),
        ["interrupted", "completed"],
      );
      assert.equal(ended[0]?.threadDisposition, "broken");
      assert.sameMembers(
        ended.map((event) => event.providerThreadId),
        [thread.id, other.id],
      );
    }),
  );

  it.effect.each([503, 429])(
    "recovers an owned server after more than five HTTP %s reconciliation replies",
    (status) =>
      Effect.gen(function* () {
        const allowRecovery = yield* Deferred.make<void>();
        const attempts = yield* Queue.unbounded<void>();
        let attempt = 0;
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            { type: "runtime_exit", status: "success" },
            out("event.subscribe"),
            ...Array.from({ length: 6 }, () => [
              out("session.active"),
              reply("session.active", { status, body: { message: "Recovering" } }),
            ]).flat(),
            ...reconnected({ [SESSION]: { type: "running" } }).slice(2),
            ...openRequests([]),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          {
            beforeResponse: (path) =>
              path === "/api/session/active"
                ? Effect.gen(function* () {
                    attempt += 1;
                    yield* Queue.offer(attempts, undefined);
                    if (attempt === 7) yield* Deferred.await(allowRecovery);
                  })
                : Effect.void,
          },
        );
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        for (let retry = 0; retry < 6; retry += 1) {
          yield* Queue.take(attempts);
          yield* TestClock.adjust("30 seconds");
        }
        yield* Queue.take(attempts);
        yield* Deferred.succeed(allowRecovery, undefined);
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      }),
  );

  it.effect(
    "keeps a $skill found on the first read when the reread after the scan comes back empty",
    () =>
      Effect.gen(function* () {
        const prompts: Array<unknown> = [];
        const greet = {
          id: "greet",
          name: "greet",
          path: `${WORK}/.opencode/skills/greet/SKILL.md`,
          content: "Say hello.",
        };
        const { runtime, thread } = yield* resumed(
          [
            out("skill.list", { "location[directory]": WORK }),
            reply("skill.list", { location: { directory: WORK }, data: [greet] }),
            ...directoryModels(WORK),
            out("skill.list", { "location[directory]": WORK }),
            reply("skill.list", { location: { directory: WORK }, data: [] }),
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { onPrompt: (input) => prompts.push(input) },
        );
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn({
          ...turnInput(thread),
          message: { ...turnInput(thread).message, text: "$greet then echo $HOME" },
        });
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
        assert.deepInclude(prompts[0], { skills: [{ id: "greet" }] });
      }),
  );

  it.effect.each([
    {
      server: "an external server keeps rejecting requests",
      external: true,
      status: 503,
      tries: 5,
    },
    { server: "an owned server rejects its credentials", external: false, status: 401, tries: 1 },
  ])("bounds recovery when $server", ({ external, status, tries }) =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<void>();
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          { type: "runtime_exit", status: "success" },
          ...Array.from({ length: tries }, () => [
            out("event.subscribe"),
            out("session.active"),
            reply("session.active", { status, body: { message: "Unavailable" } }),
          ]).flat(),
        ],
        {
          external,
          beforeResponse: (path) =>
            path === "/api/session/active"
              ? Queue.offer(attempts, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      for (let attempt = 1; attempt < tries; attempt += 1) {
        yield* Queue.take(attempts);
        yield* TestClock.adjust("2 seconds");
      }
      yield* Queue.take(attempts);
      assert.equal((yield* Fiber.join(terminal))?.status, "failed");
    }),
  );

  it.effect.each(["lists", "stream"] as const)(
    "restores approvals and questions from %s after slow recovery",
    (source) =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["late-permission"]);
        let holdReads = false;
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const requests = yield* Queue.unbounded<RuntimeRequestId>();
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...reconnected({ [SESSION]: { type: "running" } }),
            ...openRequests(
              source === "lists" ? [shellAsk.data] : [],
              source === "lists" ? [colorForm] : [],
            ),
            ...(source === "stream"
              ? [
                  event("permission.asked", shellAsk.data, "late-permission"),
                  event("form.created", { form: colorForm }),
                ]
              : []),
            out("permission.reply", {
              sessionID: SESSION,
              requestID: shellAsk.data.id,
              decision: "once",
            }),
            reply("permission.reply", null),
            out("session.form.reply", {
              sessionID: SESSION,
              formID: colorForm.id,
              answer: { q0: "Red" },
            }),
            reply("session.form.reply", null),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          {
            supervised: true,
            replayGate: gate,
            beforeResponse: (path) =>
              holdReads && path.endsWith(source === "stream" ? "/form" : "/message")
                ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          },
        );
        const ended = yield* Deferred.make<string>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
              ) {
                yield* Queue.offer(requests, event.runtimeRequest.id);
              }
              if (event.type === "turn.terminal") {
                yield* Deferred.succeed(ended, event.status);
              }
            }),
          ),
          Effect.forkScoped,
        );
        holdReads = true;
        yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
        yield* Deferred.await(reading);
        if (source === "stream") {
          yield* Effect.promise(() => gate.waitForReached("late-permission"));
          gate.release("late-permission");
        }
        yield* TestClock.adjust("2 minutes");
        assert.equal(yield* Queue.size(requests), 0);
        yield* Deferred.succeed(resume, undefined);
        yield* runtime.respondToRuntimeRequest({
          requestId: yield* Queue.take(requests),
          decision: "accept",
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: yield* Queue.take(requests),
          answers: { q0: "Red" },
        });
        assert.equal(yield* Deferred.await(ended), "completed");
      }),
  );

  it.effect(
    "recovers through a restarted server when the process exits during a history read",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        let restarted = false;
        let held = false;
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            ...reconnected({ [SESSION]: { type: "running" } }),
            ...reconnected({}).slice(1),
          ],
          {
            // The replay lends one connection; only the first borrow's process exits.
            processExit: Effect.suspend(() =>
              restarted
                ? Effect.never
                : Effect.sleep("1 second").pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        restarted = true;
                      }),
                    ),
                  ),
            ),
            beforeResponse: (path) =>
              path.endsWith("/message") && !held
                ? Effect.sync(() => (held = true)).pipe(
                    Effect.andThen(Deferred.succeed(reading, undefined)),
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
                  )
                : Effect.void,
          },
        );
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn(turnInput(thread));
        yield* Deferred.await(reading);
        // The exit at 1s cuts the stalled read; the retry 2s later borrows the restarted server.
        yield* TestClock.adjust("3 seconds");
        yield* Deferred.await(cancelled);
        assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
        assert.equal(runtime.providerSession.status, "ready");
      }),
  );

  it.effect("releases a recovering session on shutdown without waiting for its HTTP read", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const reading = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const borrowers = { current: 0 };
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          ...reconnected({ [SESSION]: { type: "running" } }),
        ],
        {
          borrowers,
          beforeResponse: (path) =>
            path.endsWith("/message")
              ? Deferred.succeed(reading, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
                )
              : Effect.void,
        },
      ).pipe(Effect.provideService(Scope.Scope, sessionScope));
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      assert.equal(borrowers.current, 1);
      yield* Scope.close(sessionScope, Exit.void);
      yield* Deferred.await(cancelled);
      assert.equal(borrowers.current, 0);
    }),
  );

  it.effect("honors a confirmed Stop during recovery and ignores its late backfill", () =>
    Effect.gen(function* () {
      const recovered = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          ...reconnected({ [SESSION]: { type: "running" } }),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          ...openRequests([]),
          event("session.execution.interrupted", { sessionID: SESSION }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "recovered" },
          }),
        ],
        {
          beforeResponse: (path) =>
            path.endsWith("/message")
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
        },
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const stopped = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/recovered"
            ) {
              yield* Deferred.succeed(recovered, undefined);
            }
            if (event.type === "turn.terminal") yield* Deferred.succeed(stopped, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      const stopping = yield* runtime
        .interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
        })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(stopping);
      assert.equal(runtime.providerSession.status, "ready");
      yield* Deferred.await(stopped);
      yield* Deferred.succeed(resume, undefined);
      yield* Deferred.await(recovered);
      assert.deepEqual(
        collected.filter((event) => event.type === "turn.terminal").map((event) => event.status),
        ["interrupted"],
      );
      assert.isFalse(
        collected.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        ),
      );
    }),
  );

  it.effect("keeps a background child's requests when its parent stops during reconciliation", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const permission = { ...shellAsk.data, sessionID: CHILD };
      const form = { ...colorForm, sessionID: CHILD };
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("permission.asked", permission),
          event("form.created", { form }),
          ...reconnected({ [SESSION]: { type: "running" }, [CHILD]: { type: "running" } }),
          ...openRequests([]),
          out("permission.list", { sessionID: CHILD }),
          replyData("permission.list", [permission]),
          out("session.form.list", { sessionID: CHILD }),
          replyData("session.form.list", [form]),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "recovered" },
          }),
          out("permission.reply", { sessionID: CHILD, requestID: permission.id, decision: "once" }),
          reply("permission.reply", null),
          out("session.form.reply", { sessionID: CHILD, formID: form.id, answer: { q0: "Red" } }),
          reply("session.form.reply", null),
        ],
        {
          beforeResponse: (path) =>
            path === `/api/session/${CHILD}/form`
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
        },
      );
      const requests = new Map<
        string,
        { readonly id: RuntimeRequestId; readonly status: string }
      >();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "runtime_request.updated") {
              const nativeId = event.runtimeRequest.nativeRequestRef?.nativeId;
              if (nativeId != null) requests.set(nativeId, event.runtimeRequest);
            }
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/recovered"
            ) {
              yield* Deferred.succeed(recovered, undefined);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(reading);
      const stopping = yield* runtime
        .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(stopping);
      yield* Deferred.succeed(resume, undefined);
      yield* Deferred.await(recovered);
      assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      assert.equal(requests.get(permission.id)?.status, "pending");
      assert.equal(requests.get(form.id)?.status, "pending");
      yield* runtime.respondToRuntimeRequest({
        requestId: requests.get(permission.id)!.id,
        decision: "accept",
      });
      yield* runtime.respondToRuntimeRequest({
        requestId: requests.get(form.id)!.id,
        answers: { q0: "Red" },
      });
    }),
  );

  it.effect("keeps a turn still running after a reconnect open for its next events", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        ...reconnected({ [SESSION]: { type: "running" } }),
        ...openRequests([]),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant_after",
          ordinal: 0,
          text: "Arrived on the new stream.",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.includeMembers(texts, [
        "Sent while the stream was down.",
        "Arrived on the new stream.",
      ]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }),
  );

  it.effect("continues a reply still streaming at reconnect from the text already shown", () =>
    Effect.gen(function* () {
      const delta = (text: string) =>
        event("session.text.delta", {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant_gap",
          ordinal: 0,
          delta: text,
        });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        delta("Sent before the stream dropped"),
        // OpenCode saves a block's text only when the block ends.
        ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
          content: [{ type: "text", text: "" }],
          finish: undefined,
        }),
        ...openRequests([]),
        delta(" and after it came back."),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.deepEqual(texts, [
        "Sent before the stream dropped",
        "Sent before the stream dropped",
        "Sent before the stream dropped and after it came back.",
        "Sent before the stream dropped and after it came back.",
      ]);
    }),
  );

  it.effect("shows a permission asked while the stream was down, and answers it", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          ...reconnected({ [SESSION]: { type: "running" } }),
          ...openRequests([shellAsk.data]),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      assert.equal(request?.nativeRequestRef?.nativeId, shellAsk.data.id);
      yield* runtime.respondToRuntimeRequest({ requestId: request!.id, decision: "accept" });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("settles a request OpenCode no longer lists after the stream came back", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          ...reconnected({ [SESSION]: { type: "running" } }),
          ...openRequests([]),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const collected = yield* Fiber.join(events);
      const statuses = collected.flatMap((event) =>
        event.type === "runtime_request.updated" ? [event.runtimeRequest.status] : [],
      );
      assert.deepEqual(statuses, ["pending", "cancelled"]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
    }),
  );

  it.effect.each(["delegate_task", "html_preview", "mcp__acme__edit_document"])(
    "keeps MCP %s as a dynamic tool through its lifecycle",
    (toolName) =>
      Effect.gen(function* () {
        const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-wait" };
        const name = toolName.startsWith("mcp__") ? toolName : `t3-code-web_${toolName}`;
        const input =
          toolName !== "delegate_task"
            ? { html: "<p>Preview</p>" }
            : { task: "Review", mode: "wait" };
        const { runtime, thread } = yield* resumed([
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.tool.input.started", { ...tool, name }),
          event("session.tool.called", { ...tool, name, input, executed: true }),
          event(
            "session.tool.success",
            {
              ...tool,
              content: [
                { type: "text", text: "Reviewed" },
                ...(toolName !== "delegate_task"
                  ? [{ type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" }]
                  : []),
              ],
              metadata: {},
              executed: true,
            },
            undefined,
            2,
          ),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ]);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const items = (yield* Fiber.join(events)).flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId?.endsWith(tool.id)
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((item) => item.type),
          ["dynamic_tool", "dynamic_tool", "dynamic_tool"],
        );
        assert.deepEqual(
          items.map((item) => item.status),
          ["running", "running", "completed"],
        );
        const last = items.at(-1);
        assert.equal(last?.type === "dynamic_tool" ? last.toolName : null, name);
        assert.deepEqual(last?.type === "dynamic_tool" ? last.input : null, input);
        assert.deepEqual(
          toolOutputImages(last?.type === "dynamic_tool" ? last.output : null),
          toolName !== "delegate_task" ? [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] : [],
        );
      }),
  );

  it.effect.each(["completed", "error", "cancelled"] as const)(
    "retains native image job %s after its launch returns",
    (outcome) =>
      Effect.gen(function* () {
        const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-image" };
        const notice = (sessionID: string) =>
          event("session.inbox.enqueued", {
            sessionID,
            inboxID: `msg_image_${sessionID}`,
            item: {
              type: "synthetic",
              delivery: "steer",
              payload: {
                description: "Image generation",
                text:
                  outcome === "completed"
                    ? "Image outcome retained. Saved image: /work/opencode2/image.png (test/image)."
                    : "Image outcome retained",
                metadata: {
                  source: "experimental_image_generate",
                  jobID: "image_test",
                  state: outcome,
                  path: "/work/opencode2/image",
                },
              },
            },
          });
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.tool.input.started", { ...tool, name: "experimental_image_generate" }),
            event("session.tool.called", { ...tool, input: { prompt: "A tree" }, executed: false }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Job launched" }],
                metadata: {
                  jobID: "image_test",
                  path: "/work/opencode2/image",
                  model: "test/image",
                },
                executed: false,
              },
              undefined,
              2,
            ),
            event("session.execution.succeeded", { sessionID: SESSION }),
            notice("ses_other"),
            notice(SESSION),
            ...(outcome === "completed"
              ? [
                  out("image.read", {
                    path: "/api/fs/read/image.png",
                    "location[directory]": WORK,
                  }),
                  reply("image.read", { imageBase64: "iVBORw0KGgo=" }),
                ]
              : []),
          ],
          { external: true },
        );
        let launched = false;
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => {
            if (e.type !== "provider_thread.updated") return false;
            if (
              e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_test")
            )
              launched = true;
            return launched && e.pendingBackgroundWork === false;
          }),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        const items = collected.flatMap((e) =>
          e.type === "turn_item.updated" && e.turnItem.nativeItemRef?.nativeId === "call-image"
            ? [e.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((item) => item.status),
          [
            "running",
            "running",
            "running",
            outcome === "error" ? "failed" : outcome === "cancelled" ? "interrupted" : "completed",
          ],
        );
        assert.include(JSON.stringify(items.at(-1)), "Image outcome retained");
        if (outcome === "completed") {
          const item = items.at(-1);
          assert.deepEqual(item?.type === "dynamic_tool" ? toolOutputImages(item.output) : [], [
            { mimeType: "image/png", data: "iVBORw0KGgo=" },
          ]);
        }
        const rosters = collected.flatMap((e) =>
          e.type === "provider_thread.updated"
            ? [e.providerThread.pendingBackgroundTasks ?? []]
            : [],
        );
        assert.isTrue(rosters.some((tasks) => tasks.some((task) => task.taskId === "image_test")));
        assert.deepEqual(rosters.at(-1), []);
      }),
  );

  it.effect.each(["history", "list", "late-preview"] as const)(
    "recovers native image job outcomes from %s after reconnect",
    (source) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...(() => {
              const frames: Array<ProviderReplayEntry> = reconnected({}, "succeeded", {
                content: [
                  {
                    type: "tool",
                    id: "call-image-gap",
                    name: "experimental_image_generate",
                    executed: false,
                    state: {
                      status: "completed",
                      input: { prompt: "A tree" },
                      content: [{ type: "text", text: "Job launched" }],
                      metadata: { jobID: "image_gap", path: "/tmp/image", model: "test/image" },
                    },
                    time: { created: 2, ran: 2, completed: 2 },
                  },
                ],
              });
              if (source !== "history")
                frames.splice(
                  2,
                  0,
                  out("rpc.call", "<any>"),
                  reply("rpc.call", { output: null }),
                  out("job.list", { kind: "shell" }),
                  reply("job.list", { data: [] }),
                );
              return frames;
            })(),
            out("message.list", { sessionID: SESSION, type: "synthetic", limit: "100" }),
            reply("message.list", {
              data:
                source !== "history"
                  ? []
                  : [
                      {
                        id: "msg_image_gap",
                        time: { created: 3 },
                        type: "synthetic",
                        text: "Recovered image failure",
                        description: "Image generation",
                        metadata: {
                          source: "experimental_image_generate",
                          jobID: "image_gap",
                          state: "error",
                          path: "/tmp/image",
                        },
                      },
                    ],
              cursor: {},
            }),
            ...(source !== "history"
              ? [
                  out("imageJobs", { sessionID: SESSION, kind: "image" }),
                  reply("imageJobs", {
                    data: [
                      {
                        kind: "image",
                        id: "image_gap",
                        sessionID: SESSION,
                        status: source === "late-preview" ? "completed" : "error",
                        path: "/tmp/image",
                        model: "test/image",
                        time: { started: 2, completed: 3 },
                      },
                    ],
                  }),
                ]
              : []),
            ...(source === "late-preview"
              ? [
                  event("session.inbox.enqueued", {
                    sessionID: SESSION,
                    inboxID: "msg_image_late",
                    item: {
                      type: "synthetic",
                      delivery: "steer",
                      payload: {
                        description: "Image generation",
                        text: "Image request finished. Saved image: /tmp/image.png (test/image).",
                        metadata: {
                          source: "experimental_image_generate",
                          jobID: "image_gap",
                          state: "completed",
                          path: "/tmp/image",
                        },
                      },
                    },
                  }),
                  out("image.read", {
                    path: "/api/fs/read/image.png",
                    "location[directory]": "/tmp",
                  }),
                  reply("image.read", { imageBase64: "iVBORw0KGgo=" }),
                ]
              : []),
          ],
          { ...(source !== "history" ? { version: "2.2.6" as const } : {}), external: true },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.nativeItemRef?.nativeId === "call-image-gap" &&
              (source === "late-preview"
                ? e.turnItem.type === "dynamic_tool" &&
                  toolOutputImages(e.turnItem.output).length > 0
                : e.turnItem.status === "failed"),
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        assert.include(
          JSON.stringify(collected.at(-1)),
          source === "late-preview"
            ? "Saved image: /tmp/image.png"
            : source !== "history"
              ? "Image generation error"
              : "Recovered image failure",
        );
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "provider_thread.updated" &&
              e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_gap"),
          ),
        );
      }),
  );

  it.effect("settles a recovered image outcome when preview I/O is interrupted", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const fs = yield* FileSystem.FileSystem;
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          ...reconnected({}, "succeeded", {
            content: [
              {
                type: "tool",
                id: "call-image-slow",
                name: "experimental_image_generate",
                executed: false,
                state: {
                  status: "completed",
                  input: { prompt: "A tree" },
                  content: [{ type: "text", text: "Launched" }],
                  metadata: { jobID: "image_slow", path: "/tmp/image", model: "test/image" },
                },
                time: { created: 2, ran: 2, completed: 2 },
              },
            ],
          }),
          out("message.list", { sessionID: SESSION, type: "synthetic", limit: "100" }),
          reply("message.list", {
            data: [
              {
                id: "msg_image_slow",
                type: "synthetic",
                time: { created: 3 },
                text: "Image request finished. Saved image: /tmp/image.png (test/image).",
                description: "Image generation",
                metadata: {
                  source: "experimental_image_generate",
                  jobID: "image_slow",
                  state: "completed",
                  path: "/tmp/image",
                },
              },
            ],
            cursor: {},
          }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { providerID: "opencode", id: "big-pickle", variant: "recovery-observed" },
          }),
        ],
        {
          fileSystem: {
            ...fs,
            stat: (path) =>
              path === "/tmp/image.png"
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                  )
                : fs.stat(path),
          },
        },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil(
          (e) =>
            e.type === "provider_thread.updated" &&
            e.providerThread.nativeMetadata?.modelSelection?.options?.some(
              (option) => option.value === "recovery-observed",
            ) === true,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(reading);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(interrupted);
      const collected = yield* Fiber.join(events);
      assert.isTrue(
        collected.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.nativeItemRef?.nativeId === "call-image-slow" &&
            e.turnItem.status === "completed",
        ),
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["root", "child"] as const)(
    "settles %s native image tasks when reconnect attempts fail",
    (owner) =>
      Effect.gen(function* () {
        const attempts = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
        let count = 0;
        let failures = 0;
        const borrowers = {
          get current() {
            return count;
          },
          set current(next: number) {
            if (next < count && count === 2) {
              const attempt = attempts[failures++];
              if (attempt !== undefined) Deferred.doneUnsafe(attempt, Effect.void);
            }
            count = next;
          },
        };
        const tool = {
          sessionID: owner === "root" ? SESSION : CHILD,
          assistantMessageID: "msg_assistant",
          id: "call-image-lost",
        };
        const { runtime, thread } = yield* resumed(
          [
            ...(owner === "root"
              ? [out("session.prompt", { sessionID: SESSION, text: "<any>" }), promptAccepted]
              : [
                  ...backgroundLaunch(CHILD),
                  event("session.execution.started", { sessionID: CHILD }),
                ]),
            event("session.tool.input.started", { ...tool, name: "experimental_image_generate" }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Launched" }],
                metadata: { jobID: "image_lost", path: "/tmp/image", model: "test/image" },
                executed: false,
              },
              undefined,
              2,
            ),
            ...(owner === "child"
              ? [event("session.execution.succeeded", { sessionID: CHILD })]
              : []),
            event("session.execution.succeeded", { sessionID: SESSION }),
            { type: "runtime_exit", status: "success" },
          ],
          { borrowers },
        );
        const events = yield* runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(attempts[0]!);
        for (const attempt of attempts.slice(1)) {
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.await(attempt);
        }
        const collected = yield* Fiber.join(events);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.nativeItemRef?.nativeId ===
                (owner === "root" ? tool.id : `${CHILD}:${tool.id}`) &&
              e.turnItem.status === "failed",
          ),
        );
        const rootSnapshots = collected.flatMap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.id === thread.id ? [e] : [],
        );
        assert.isFalse(rootSnapshots.at(-1)?.pendingBackgroundWork);
        assert.deepEqual(rootSnapshots.at(-1)?.providerThread.pendingBackgroundTasks, []);
        assert.isTrue(
          rootSnapshots.some((e) =>
            e.providerThread.pendingBackgroundTasks?.some((task) => task.taskId === "image_lost"),
          ),
        );
      }),
  );

  it.effect("projects successful native todo updates into one checklist", () =>
    Effect.gen(function* () {
      const updates = [
        [
          { content: " Inspect code ", status: "completed" },
          { content: "Implement", status: "in_progress" },
          { content: "Verify", status: "pending" },
          { content: "Abandoned", status: "cancelled" },
        ],
        [{ content: "Inspect code", status: "completed" }],
        [{ content: "Abandoned", status: "cancelled" }],
        [],
        [{ content: "Follow up", status: "pending" }],
      ];
      const tool = (id: string) => ({
        sessionID: SESSION,
        assistantMessageID: "msg_assistant",
        id,
      });
      const call = (id: string, todos: unknown): ReadonlyArray<ProviderReplayEntry> => [
        event("session.tool.input.started", { ...tool(id), name: "todowrite" }),
        event("session.tool.called", { ...tool(id), input: { todos }, executed: false }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        ...call("call-denied", [{ content: "Not saved", status: "pending" }]),
        event(
          "session.tool.failed",
          {
            ...tool("call-denied"),
            error: { type: "unknown", message: "Unable to update todos" },
            executed: false,
          },
          undefined,
          2,
        ),
        ...call("call-malformed", [{ content: "Not saved", status: "pending" }]),
        event(
          "session.tool.success",
          {
            ...tool("call-malformed"),
            content: [{ type: "text", text: "Unrecognized todo result" }],
            metadata: { todos: [{ content: "Unknown", status: "new-status" }] },
            executed: false,
          },
          undefined,
          2,
        ),
        ...updates.flatMap((todos, index) => [
          ...call(`call-todo-${index}`, todos),
          event(
            "session.tool.success",
            {
              ...tool(`call-todo-${index}`),
              content: [{ type: "text", text: "Todos updated" }],
              metadata: { todos },
              executed: false,
            },
            undefined,
            2,
          ),
        ]),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const plans = collected.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
      assert.deepEqual(
        plans.map((plan) => plan.steps.map((step) => [step.text, step.status])),
        [
          [
            ["Inspect code", "completed"],
            ["Implement", "running"],
            ["Verify", "pending"],
          ],
          [["Inspect code", "completed"]],
          [],
          [],
          [["Follow up", "pending"]],
        ],
      );
      assert.equal(new Set(plans.map((plan) => plan.id)).size, 1);
      assert.equal(plans[0]?.steps[0]?.id, plans[1]?.steps[0]?.id);
      assert.deepEqual(
        plans.map((plan) => plan.status),
        ["active", "completed", "completed", "completed", "active"],
      );
      const items = collected.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const checklists = items.filter((item) => item.type === "todo_list");
      assert.equal(new Set(checklists.map((item) => item.id)).size, 1);
      assert.deepEqual(
        checklists.map((item) => item.steps),
        plans.map((plan) => plan.steps),
      );
      assert.deepEqual(
        checklists.map((item) => item.status),
        ["completed", "completed", "completed", "completed", "completed"],
      );
      assert.isFalse(
        items.some(
          (item) =>
            item.type === "dynamic_tool" && item.nativeItemRef?.nativeId?.startsWith("call-todo-"),
        ),
      );
      assert.deepInclude(
        items.find((item) => item.nativeItemRef?.nativeId === "call-denied"),
        { type: "dynamic_tool", status: "failed" },
      );
      assert.deepInclude(
        items.find((item) => item.nativeItemRef?.nativeId === "call-malformed"),
        { type: "dynamic_tool", status: "completed" },
      );
    }),
  );

  it.effect("recovers native todo updates missed during reconnect", () =>
    Effect.gen(function* () {
      const todos = [{ content: "Saved during disconnect", status: "in_progress" }];
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        ...reconnected({}, "succeeded", {
          content: [
            {
              type: "tool",
              id: "call-todo-gap",
              name: "todowrite",
              executed: false,
              state: {
                status: "completed",
                input: { todos },
                content: [{ type: "text", text: "Todos updated" }],
                metadata: { todos },
              },
              time: { created: 2, ran: 2, completed: 2 },
            },
          ],
        }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const plans = collected.flatMap((event) =>
        event.type === "plan.updated" && event.plan.kind === "todo_list" ? [event.plan] : [],
      );
      assert.equal(plans.length, 1);
      assert.deepEqual(
        plans[0]?.steps.map((step) => [step.text, step.status]),
        [["Saved during disconnect", "running"]],
      );
      assert.include(turnItems(collected), "todo_list:completed");
    }),
  );

  it.effect("stores a shell command that exits non-zero as failed", () =>
    Effect.gen(function* () {
      const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-exit" };
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.tool.input.started", { ...tool, name: "shell" }),
        event("session.tool.called", { ...tool, input: { command: "vp test" }, executed: false }),
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_toolsuccess_call-exit",
              created: 1,
              type: "session.tool.success",
              data: {
                ...tool,
                content: [{ type: "text", text: "1 failed\n" }],
                metadata: { status: "completed", truncated: false, exit: 1 },
                executed: false,
              },
              durable: { aggregateID: SESSION, seq: 1, version: 2 },
            },
          },
        },
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const item = collected
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.nativeItemRef?.nativeId?.endsWith(tool.id));
      assert.equal(item?.type, "command_execution");
      assert.equal(item?.status, "failed");
      assert.equal(item?.type === "command_execution" ? item.exitCode : null, 1);
      assert.equal(
        collected
          .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
          .findLast((node) => node.id === item?.nodeId)?.status,
        "failed",
      );
    }),
  );

  it.effect("re-registers T3 MCP each turn and drops its instructions when adding fails", () =>
    Effect.gen(function* () {
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-adapter"),
        threadId,
        providerSessionId: "mcp:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
      const server = "t3-code-thread_opencode2-adapter";
      const add = out("mcp.add", {
        server,
        "location[directory]": WORK,
        config: {
          type: "remote",
          url: "http://127.0.0.1:3773/mcp",
          headers: { Authorization: "Bearer thread-credential" },
          oauth: false,
        },
      });
      const turn = [
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ];
      const prompts: Array<unknown> = [];
      // Idle Location eviction drops OpenCode's runtime MCP servers without a reconnect.
      const { runtime, thread } = yield* resumed(
        [
          add,
          reply("mcp.add", null),
          ...turn,
          add,
          reply("mcp.add", { status: 500, body: { message: "MCP unavailable" } }),
          out("session.instructions.entry.put", {
            sessionID: SESSION,
            key: "t3-code",
            value: buildRuntimeInstructions({ harness: "OpenCode", model: bigPickle.model }),
          }),
          reply("session.instructions.entry.put", null),
          ...turn,
          out("mcp.remove", { server, "location[directory]": WORK }),
          reply("mcp.remove", null),
        ],
        { onPrompt: (input) => prompts.push(input) },
      );
      for (let index = 0; index < 2; index++) {
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        const started = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.forkScoped);
        // OpenCode before 2.2.6 loads a newly added server's tools after a debounce.
        if (index === 0) {
          yield* TestClock.adjust("249 millis");
          assert.lengthOf(prompts, 0, "prompted before OpenCode loaded the new MCP server's tools");
          yield* TestClock.adjust("1 millis");
        }
        yield* Fiber.join(started);
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      }
    }),
  );

  it.effect("registers a long thread id's MCP server under a name OpenCode accepts", () =>
    Effect.gen(function* () {
      const child = ThreadId.make(
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Asubproject-b-round1",
      );
      const server = "t3-code-aa73fa1e03099934";
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set({
        environmentId: EnvironmentId.make("environment:opencode2-adapter"),
        threadId: child,
        providerSessionId: "mcp:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
      });
      yield* Effect.addFinalizer(() => mcpSessions.clear(child));
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData(
          "session.get",
          sessionInfo({
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "t3-code-*", resource: "*", effect: "deny" },
              { action: `${server}_*`, resource: "*", effect: "allow" },
            ],
          }),
        ),
        ...noOpenRequests,
        out("mcp.add", {
          server,
          "location[directory]": WORK,
          config: {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp",
            headers: { Authorization: "Bearer thread-credential" },
            oauth: false,
          },
        }),
        reply("mcp.add", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("mcp.remove", { server, "location[directory]": WORK }),
        reply("mcp.remove", null),
      ]);
      const thread = yield* runtime.resumeThread({
        providerThread: { ...providerThread(yield* DateTime.now), appThreadId: child },
        threadId: child,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const started = yield* runtime
        .startTurn({ ...turnInput(thread), threadId: child })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(started);
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      yield* runtime.unloadThread!({ providerThread: thread });
    }),
  );

  // regression: #16142 OpenCode 2 threads were missing T3 Code's MCP tools
  it.effect("names each thread's MCP server within OpenCode's limits, one name per thread", () =>
    Effect.gen(function* () {
      const project = "thread:project:ce04e4e2-6c29-4ff0-a1d7-b089dd63e258";
      const ids = [
        `${project}:d3b2d715-c4a1-4b63-bb65-1634c3a3a8c4`,
        `${project}:d3b2d715-c4a1-4b63-bb65-1634c3a3a8c5`,
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Around1",
        "thread:delegated-task:command%3Amcp%3A48bef2bf-6d0e-4f7a-9c3b-2e5d8a1f7c40%3Adelegate-task%3Around2",
      ];
      const names = yield* Effect.forEach(ids, t3McpServerName);
      for (const name of names) assert.match(name, /^t3-code-[A-Za-z0-9_-]{1,56}$/);
      assert.equal(new Set(names).size, ids.length);
      assert.deepEqual(yield* Effect.forEach(ids, t3McpServerName), names);
      assert.equal(names[0], "t3-code-63abb5df2b188bdd");
      assert.equal(yield* t3McpServerName(threadId), "t3-code-thread_opencode2-adapter");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect.each([
    {
      external: false,
      name: "sends only existing supported images as turn and steer prompt files with path text",
    },
    {
      external: true,
      name: "keeps turn and steer attachment paths without local files for external servers",
    },
  ])("$name", ({ external }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3 oc2 #images-",
      });
      const image = (id: string, name: string, mimeType = "image/png") =>
        ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(`thread-opencode2-adapter-${id}-1234-1234-1234-123456789abc`),
          name,
          mimeType,
          sizeBytes: 4,
        });
      const screenshot = image("12345678", "screen shot.png");
      const chart = image("abcdefab", "chart.webp", "image/webp");
      const missing = image("23456789", "missing.png");
      const unsupported = image("34567890", "diagram.svg", "image/svg+xml");
      const document = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("thread-opencode2-adapter-45678901-1234-1234-1234-123456789abc"),
        name: "requirements.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      });
      for (const attachment of [screenshot, chart, unsupported, document]) {
        yield* fileSystem.writeFileString(
          resolveAttachmentPath({ attachmentsDir, attachment })!,
          "data",
        );
      }
      const prompts: Array<unknown> = [];
      const steerId = "msg_recorded_steer_image";
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          out("session.prompt", { sessionID: SESSION, id: steerId, delivery: "steer" }),
          replyData("session.prompt", {
            id: steerId,
            sessionID: SESSION,
            time: { created: 1790656601500 },
            type: "user",
            payload: { text: "And this one?" },
            delivery: "steer",
          }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { attachmentsDir, external, onPrompt: (input) => prompts.push(input) },
      );
      const ids = yield* IdAllocator.IdAllocatorV2;
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const input = turnInput(thread);
      yield* runtime.startTurn({
        ...input,
        message: {
          ...input.message,
          text: "What is in this image?",
          attachments: [screenshot, missing, unsupported, document],
        },
      });
      yield* runtime.steerTurn({
        threadId,
        runId: input.runId,
        providerThread: thread,
        providerTurnId: ids.derive.providerTurn({
          driver: OPENCODE_PROVIDER,
          nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
        }),
        message: {
          ...input.message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "And this one?",
          attachments: [chart, missing, unsupported, document],
        },
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      assert.equal(prompts.length, 2);
      for (const [index, attachment] of [screenshot, chart].entries()) {
        const path = resolveAttachmentPath({ attachmentsDir, attachment })!;
        assert.deepInclude(prompts[index], {
          text: [
            index === 0 ? "What is in this image?" : "And this one?",
            `[Attached image "${attachment.name}" is saved at: ${path}]`,
            `[Attached image "missing.png" is saved at: ${attachmentsDir}/${missing.id}.png]`,
            `[Attached image "diagram.svg" is saved at: ${attachmentsDir}/${unsupported.id}.svg]`,
            `[Attached file "requirements.pdf" is saved at: ${attachmentsDir}/${document.id}.pdf]`,
          ].join("\n\n"),
        });
        if (external) {
          assert.notProperty(prompts[index], "files");
        } else {
          assert.deepInclude(prompts[index], {
            files: [
              {
                uri: NodeURL.pathToFileURL(path).href,
                name: attachment.name,
              },
            ],
          });
        }
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect.each([
    [false, "image", false],
    [true, "image", false],
    [false, "text", false],
    [true, "text", false],
    [true, "image", true],
    [true, "text", true],
  ] as const)(
    "rejects a steer stopped during attachment resolution (held end: %s, lookup: %s, cancel: %s)",
    ([heldEnd, lookup, cancel]) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-oc2-stopped-image-",
        });
        const image = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-opencode2-adapter-12345678-1234-1234-1234-123456789abc",
          ),
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const path = resolveAttachmentPath({ attachmentsDir, attachment: image })!;
        yield* fileSystem.writeFileString(path, "data");
        const resolving = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gate = makeProviderReplayGate(["execution-end", "interrupt-reply"]);
        const executionEnded = yield* Deferred.make<void>();
        const prompts: Array<unknown> = [];
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            ...(heldEnd
              ? [
                  event("session.execution.succeeded", { sessionID: SESSION }, "execution-end"),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_finished_before_stop",
                    ordinal: 0,
                    text: "Finished before Stop.",
                  }),
                ]
              : []),
            ...(cancel
              ? []
              : [
                  out("session.interrupt", { sessionID: SESSION }),
                  ...(heldEnd
                    ? [event("session.usage.updated", { sessionID: SESSION }, "interrupt-reply")]
                    : []),
                  reply("session.interrupt", { interrupted: !heldEnd }),
                  ...(heldEnd
                    ? []
                    : [event("session.execution.interrupted", { sessionID: SESSION })]),
                ]),
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          {
            attachmentsDir,
            replayGate: gate,
            onPrompt: (input) => prompts.push(input),
            ...(lookup === "text"
              ? {
                  resolveExtractedTextPath: () =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(resolving, undefined);
                      yield* Deferred.await(release);
                      return undefined;
                    }),
                }
              : {}),
            fileSystem: {
              ...fileSystem,
              exists: (file) =>
                lookup === "image" && file === path
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(resolving, undefined);
                      yield* Deferred.await(release);
                      return yield* fileSystem.exists(file);
                    })
                  : fileSystem.exists(file),
            },
          },
        );
        const stopped = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const terminals: Array<string> = [];
        yield* runtime.events.pipe(
          Stream.tap((event) => {
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "Finished before Stop."
            ) {
              return Deferred.succeed(executionEnded, undefined);
            }
            if (event.type !== "turn.terminal") return Effect.void;
            terminals.push(event.status);
            return Deferred.succeed(terminals.length === 1 ? stopped : completed, undefined);
          }),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const steer = yield* runtime
          .steerTurn({
            threadId,
            runId: RunId.make("run:opencode2-adapter"),
            providerThread: thread,
            providerTurnId: yield* providerTurnId,
            message: {
              ...turnInput(thread).message,
              messageId: MessageId.make("message:opencode2-adapter:steer"),
              text: "Do not send this image after Stop.",
              attachments: [image],
            },
          })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(resolving);
        if (heldEnd) {
          gate.release("execution-end");
          yield* Deferred.await(executionEnded);
        }
        if (cancel) {
          yield* Fiber.interrupt(steer);
        }
        const interrupt = cancel
          ? undefined
          : yield* runtime
              .interruptTurn({
                providerThread: thread,
                providerTurnId: yield* providerTurnId,
              })
              .pipe(Effect.forkScoped);
        if (!cancel && heldEnd) {
          assert.isTrue(yield* Effect.promise(() => gate.waitForReached("interrupt-reply")));
        } else if (!cancel) {
          yield* Deferred.await(stopped);
        }
        yield* Deferred.succeed(release, undefined);
        assert.lengthOf(prompts, 1);
        if (cancel) {
          assert.isTrue(Exit.isFailure(yield* Fiber.await(steer)));
        } else {
          const result = yield* Fiber.join(steer);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result)) {
            assert.deepInclude(Cause.squash(result.cause), {
              _tag: "ProviderAdapterProtocolError",
            });
          }
        }
        yield* Deferred.await(stopped);
        gate.release("interrupt-reply");
        if (interrupt) yield* Fiber.join(interrupt);
        yield* runtime.startTurn(secondTurn(thread));
        yield* Deferred.await(completed);
        assert.lengthOf(prompts, 2);
        assert.deepEqual(terminals, [cancel ? "completed" : "interrupted", "completed"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads user and assistant text from the session's message list", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("message.list", { sessionID: SESSION, order: "asc", limit: "100" }),
        reply("message.list", history),
      ]);
      const snapshot = yield* runtime.readThreadSnapshot({
        providerThread: providerThread(yield* DateTime.now),
      });
      assert.deepEqual(
        snapshot.messages.map((message) => [message.role, message.text]),
        [
          ["user", history.data[0]!.text],
          ["assistant", "391 is not prime: it's the product 17 × 23."],
        ],
      );
      assert.equal(
        snapshot.providerThread.nativeConversationHeadRef?.nativeId,
        history.data[0]!.id,
      );
    }),
  );

  it.effect("ends a turn before re-reading a model list that never answers", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        out("event.subscribe"),
        out("model.list", "<any>"),
        reply("model.list", { location: { directory: WORK }, data: [] }),
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("model.list", "<any>"),
        reply("model.list", "<hang>"),
      ]);
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    }),
  );

  it.effect("leaves models unknown when a step ends without a seen start", () =>
    Effect.gen(function* () {
      const tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
      const step = (id: string) => ({ sessionID: SESSION, assistantMessageID: id });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.started", {
          ...step("msg_seen"),
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          started: 1,
        }),
        event("session.step.ended", { ...step("msg_seen"), finish: "tool-calls", cost: 0, tokens }),
        event("session.step.ended", { ...step("msg_unseen"), finish: "stop", cost: 0, tokens }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const turn = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const settled = Option.getOrUndefined(yield* Fiber.join(turn));
      const usage =
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined;
      assert.deepInclude(usage, { usageStatus: "complete", inputTokens: 20, outputTokens: 2 });
      assert.notProperty(usage, "models");
    }),
  );

  it.effect("reports cache writes as cache creation, not only as input", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          finish: "stop",
          cost: 0,
          tokens: { input: 1200, output: 40, reasoning: 0, cache: { read: 300, write: 2500 } },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const turn = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const settled = Option.getOrUndefined(yield* Fiber.join(turn));
      assert.deepInclude(
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined,
        {
          inputTokens: 1200 + 300 + 2500,
          cachedInputTokens: 300,
          cacheCreationTokens: 2500,
          outputTokens: 40,
        },
      );
    }),
  );

  const ASSISTANT = "msg_0eb735d5b001oAFVeY5jz3WD4Z";
  const rateLimited = {
    type: "provider.rate-limit",
    message: "Rate limit exceeded: free-models-per-min.",
    status: 429,
  };
  /**
   * OpenCode numbers the request it retries with, so its first retry is
   * attempt 2, and stamps `at` from the clock behind the event's `created` (1 here).
   */
  const retryScheduled = (attempt: number, delayMs: number) =>
    event("session.retry.scheduled", {
      sessionID: SESSION,
      assistantMessageID: ASSISTANT,
      attempt,
      at: 1 + delayMs,
      error: rateLimited,
    });
  const retrying = {
    class: "provider_error",
    message: rateLimited.message,
    code: rateLimited.type,
    retryable: true,
  } satisfies OrchestrationV2ProviderFailure;
  const firstRetry = { attempt: 1, maxAttempts: null, retryDelayMs: 2_000 };
  const errorRows = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    collected.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem] : [],
    );
  const runRetryTurn = (entries: ReadonlyArray<ProviderReplayEntry>, gate?: ProviderReplayGate) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          ...entries,
        ],
        gate === undefined ? undefined : { replayGate: gate },
      );
      const retryShown = yield* Deferred.make<void>();
      const collected = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? Deferred.succeed(retryShown, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      if (gate !== undefined) {
        yield* Deferred.await(retryShown);
        yield* TestClock.adjust("5 seconds");
        gate.releaseAll();
      }
      return yield* Fiber.join(collected);
    });

  it.effect.each([
    {
      name: "recovers a provider retry at the provider's first output",
      after: [
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ],
      items: ["error:running", "error:completed", "assistant_message:completed"],
      ended: "completed" as const,
      title: "Provider recovered",
    },
    {
      name: "stops a provider retry when the user stops the turn",
      after: [event("session.execution.interrupted", { sessionID: SESSION, reason: "user" })],
      items: ["error:running", "error:interrupted"],
      ended: "interrupted" as const,
      title: "Provider retry stopped",
    },
  ])("$name", ({ after, items, ended, title }) =>
    Effect.gen(function* () {
      const seen = yield* runRetryTurn([retryScheduled(2, 2_000), ...after]);
      assert.deepEqual(turnItems(seen), items);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, title, failure, retry }) => ({ id, title, failure, retry })),
        [
          { id: rows[0]!.id, title: "Provider retry", failure: retrying, retry: firstRetry },
          { id: rows[0]!.id, title, failure: retrying, retry: firstRetry },
        ],
      );
      assert.deepInclude(seen.at(-1), { type: "turn.terminal", status: ended, failure: null });
    }),
  );

  // regression: #15672 OpenCode 2 provider retries ran silently instead of showing
  it.effect.each([
    { name: "restores retry pending at reconnect", pending: true, streamed: false },
    { name: "settles retry recovered during drop", pending: false, streamed: false },
  ])("$name", ({ pending, streamed }) =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["finish"]);
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          ...(pending && !streamed ? [] : [retryScheduled(2, 2_000)]),
          ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
            id: ASSISTANT,
            finish: undefined,
            content: pending ? [] : [{ type: "text", text: "Recovered during the drop." }],
            ...(pending && !streamed
              ? { retry: { attempt: 2, at: 2_001, error: rateLimited } }
              : {}),
            ...(streamed ? { time: { created: 2, streamed: 3 } } : {}),
          }),
          ...openRequests([shellAsk.data]),
          event("session.execution.succeeded", { sessionID: SESSION }, "finish"),
        ],
        { supervised: true, replayGate: gate },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      yield* Effect.promise(() => gate.waitForReached("finish"));
      gate.release("finish");
      const collected = yield* Fiber.join(events);
      // Reconciled requests follow backfill, before the terminal can settle the retry row.
      const reconciled = collected.findIndex((event) => event.type === "runtime_request.updated");
      assert.isAtLeast(reconciled, 0);
      const seen = collected.slice(0, reconciled);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ status, title }) => ({ status, title })),
        pending
          ? [{ status: "running", title: "Provider retry" }]
          : [
              { status: "running", title: "Provider retry" },
              { status: "completed", title: "Provider recovered" },
            ],
      );
      for (const row of rows) {
        assert.deepEqual(row.failure, retrying);
        assert.deepInclude(row.retry, { attempt: 1, maxAttempts: null });
        assert.equal(row.id, rows[0]!.id);
        assert.equal(row.ordinal, rows[0]!.ordinal);
        assert.deepEqual(row.startedAt, rows[0]!.startedAt);
      }
      if (!pending) {
        assert.isTrue(
          seen.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "Recovered during the drop.",
          ),
        );
      }
    }),
  );

  it.effect("replaces a provider retry with the error that failed the turn", () =>
    Effect.gen(function* () {
      const step = {
        sessionID: SESSION,
        assistantMessageID: ASSISTANT,
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle", variant: "default" },
        started: 1,
      };
      const gate = makeProviderReplayGate(["second retry"]);
      // OpenCode starts the step of each attempt that fails, so a step start is no recovery.
      const seen = yield* runRetryTurn(
        [
          event("session.step.started", step),
          retryScheduled(2, 2_000),
          event("session.step.started", step, "second retry"),
          retryScheduled(3, 4_000),
          event("session.step.started", step),
          event("session.step.failed", {
            sessionID: SESSION,
            assistantMessageID: ASSISTANT,
            error: rateLimited,
          }),
          event("session.execution.failed", { sessionID: SESSION, error: rateLimited }),
        ],
        gate,
      );
      const failed = { ...retrying, class: "usage_limit" as const, retryable: null };
      const lastRetry = { attempt: 2, maxAttempts: null, retryDelayMs: 4_000 };
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, status, title, failure, retry }) => ({
          id,
          status,
          title,
          failure,
          retry,
        })),
        [
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: firstRetry,
          },
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: lastRetry,
          },
          {
            id: rows[0]!.id,
            status: "failed",
            title: "Usage limit reached",
            failure: failed,
            retry: lastRetry,
          },
        ],
      );
      const { startedAt, ordinal } = rows[0]!;
      assert.ok(startedAt);
      assert.deepEqual(
        rows.map((row) => ({ startedAt: row.startedAt, ordinal: row.ordinal })),
        rows.map(() => ({ startedAt, ordinal })),
      );
      assert.isAtLeast(
        DateTime.toEpochMillis(rows[2]!.updatedAt) - DateTime.toEpochMillis(startedAt),
        5_000,
      );
      assert.deepInclude(seen.at(-1), {
        type: "turn.terminal",
        status: "failed",
        failure: failed,
        failureItemOrdinal: ordinal,
        retry: lastRetry,
        retryStartedAt: startedAt,
      });
    }),
  );

  it.effect("reports each directory's own limit for a model its project config changed", () =>
    Effect.gen(function* () {
      const custom = "/work/opencode2-custom";
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("model.list", { "location[directory]": custom }),
        reply("model.list", {
          location: { directory: custom },
          data: modelCatalog.data.map((model) => ({
            ...model,
            limit: { context: 64000, input: 48000, output: 8000 },
          })),
        }),
        out("session.create", {
          location: { directory: custom },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions: t3Rules,
        }),
        replyData("session.create", sessionInfo({ location: { directory: custom } })),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          finish: "stop",
          cost: 0,
          tokens: { input: 1200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const customPolicy = { ...policy(), cwd: custom };
      const thread = yield* runtime.ensureThread({
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: customPolicy,
      });
      assert.deepEqual(thread.nativeMetadata?.modelSelection, {
        ...bigPickle,
        options: [{ id: "variant", value: "default" }],
      });
      assert.equal(runtime.getModelContextWindow?.(bigPickle, WORK), 160000);
      assert.equal(runtime.getModelContextWindow?.(bigPickle, custom), 48000);
      const settled = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        ),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* runtime.startTurn({ ...turnInput(thread), runtimePolicy: customPolicy });
      const turn = Option.getOrUndefined(yield* Fiber.join(settled));
      assert.equal(
        turn?.type === "provider_turn.updated" ? turn.providerTurn.tokenUsage?.maxTokens : null,
        48000,
      );
    }),
  );

  it.effect("rejects unreadable rollback history before cutting the native session", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("message.list", { sessionID: SESSION, limit: "100", type: undefined }),
        reply("message.list", {
          data: [
            { id: "msg_kept", time: { created: 1 }, text: "first", type: "user" },
            {
              id: "msg_compaction",
              time: { created: 2 },
              type: "compaction",
              status: "completed",
              reason: "auto",
              summary: "First turn summary",
              recent: 42,
            },
            { id: "msg_dropped", time: { created: 3 }, text: "second", type: "user" },
          ],
          cursor: {},
        }),
      ]);
      const now = yield* DateTime.now;
      const turns = ["msg_kept", "msg_dropped"].map((nativeId, index) => ({
        id: ProviderTurnId.make(`provider-turn:rollback-history:${index}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:rollback-history:${index}`),
        runAttemptId: RunAttemptId.make(`attempt:rollback-history:${index}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal: index + 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      }));
      const failure = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:rollback-history"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRollbackThreadError");
      assert.include(Cause.pretty(Cause.fail(failure)), '["recent"]');
    }),
  );

  it.effect("clears a staged revert whose commit failed, before the next prompt too", () =>
    Effect.gen(function* () {
      const kept = "msg_t3_turn_run-attempt:kept:1";
      const dropped = "msg_t3_turn_run-attempt:dropped:1";
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", {
          status: 500,
          body: { _tag: "UnknownError", message: "disk I/O error" },
        }),
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", {
          status: 500,
          body: { _tag: "UnknownError", message: "busy" },
        }),
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", null),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, id: "<any>", text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const now = yield* DateTime.now;
      const turn = (attempt: string, ordinal: number) => ({
        id: ProviderTurnId.make(`provider-turn:${attempt}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${attempt}`),
        runAttemptId: RunAttemptId.make(`run-attempt:${attempt}:1`),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: `msg_t3_turn_run-attempt:${attempt}:1`,
          strength: "weak" as const,
        },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:kept"),
            appRunOrdinal: 1,
            providerTurn: turn("kept", 1),
          },
          providerThreadTurns: [turn("kept", 1), turn("dropped", 2)],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rollback));
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* terminalOf(runtime))?.status, "completed");
    }),
  );

  it.effect("offers no follow-up for the execution a cleared revert starts", () =>
    Effect.gen(function* () {
      const kept = "msg_t3_turn_run-attempt:kept:1";
      const dropped = "msg_t3_turn_run-attempt:dropped:1";
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", {
          status: 500,
          body: { _tag: "UnknownError", message: "disk I/O error" },
        }),
        // Uncleared stages commit on the next prompt; clearing triggers an empty execution without a T3 turn.
        out("session.revert.clear", { sessionID: SESSION }),
        reply("session.revert.clear", null),
        event("session.revert.cleared", { sessionID: SESSION }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const now = yield* DateTime.now;
      const turn = (attempt: string, ordinal: number) => ({
        id: ProviderTurnId.make(`provider-turn:${attempt}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${attempt}`),
        runAttemptId: RunAttemptId.make(`run-attempt:${attempt}:1`),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: `msg_t3_turn_run-attempt:${attempt}:1`,
          strength: "weak" as const,
        },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:kept"),
            appRunOrdinal: 1,
            providerTurn: turn("kept", 1),
          },
          providerThreadTurns: [turn("kept", 1), turn("dropped", 2)],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rollback));
      assert.lengthOf(offers, 0);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
    }),
  );

  it.effect("prompts under ids no other session on the server can hold", () =>
    Effect.gen(function* () {
      // Separate databases can repeat prompt ids on one server; OpenCode rejects cross-session duplicates with 409.
      const OTHER = "ses_f148ca2deffeOtherSession000";
      const steerInto = (session: string, recorded: string): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", {
          sessionID: session,
          id: recorded,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        event("session.inbox.delivered", { sessionID: session, inboxID: recorded }),
        event("session.execution.succeeded", { sessionID: session }),
      ];
      const promptInto = (
        session: string,
        recorded: string,
      ): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", { sessionID: session, id: recorded, text: "<any>" }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601410 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
        event("session.execution.started", { sessionID: session }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: OTHER }),
        replyData("session.get", sessionInfo({ id: OTHER })),
        out("permission.list", { sessionID: OTHER }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID: OTHER }),
        replyData("session.form.list", []),
        ...promptInto(SESSION, "msg_recorded_turn_a"),
        ...steerInto(SESSION, "msg_recorded_steer_a"),
        out("session.instructions.entry.put", { sessionID: OTHER, key: "t3-code", value: "<any>" }),
        reply("session.instructions.entry.put", null),
        ...promptInto(OTHER, "msg_recorded_turn_b"),
        ...steerInto(OTHER, "msg_recorded_steer_b"),
      ]);
      const other = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
        nativeThreadRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: OTHER,
          strength: "strong" as const,
        },
      };
      yield* runtime.resumeThread({
        providerThread: other,
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const ids = yield* IdAllocator.IdAllocatorV2;
      const ended = yield* terminals(runtime, 2);
      for (const [session, providerThread] of [
        [SESSION, thread],
        [OTHER, other],
      ] as const) {
        yield* runtime.startTurn(turnInput(providerThread));
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run:opencode2-adapter"),
          providerThread,
          providerTurnId: ids.derive.providerTurn({
            driver: OPENCODE_PROVIDER,
            nativeTurnId: `${session}:attempt:attempt:opencode2-adapter`,
          }),
          message: {
            ...turnInput(providerThread).message,
            messageId: MessageId.make("message:opencode2-adapter:steer"),
            text: "Also say STEERED.",
          },
        });
      }
      const statuses = [...(yield* Fiber.join(ended))].map((terminal) => terminal.status);
      assert.deepEqual(statuses, ["completed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );

  // regression: #16775 unchanged session status updates were rewritten on every event
  it.effect("reports the shared session's status only when it changes", () =>
    Effect.gen(function* () {
      const OTHER = "ses_f148ca2deffeOtherSession000";
      const promptInto = (
        session: string,
        recorded: string,
      ): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", { sessionID: session, id: recorded, text: "<any>" }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601410 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: OTHER }),
        replyData("session.get", sessionInfo({ id: OTHER })),
        out("permission.list", { sessionID: OTHER }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID: OTHER }),
        replyData("session.form.list", []),
        ...promptInto(SESSION, "msg_recorded_turn_a"),
        out("session.instructions.entry.put", { sessionID: OTHER, key: "t3-code", value: "<any>" }),
        reply("session.instructions.entry.put", null),
        ...promptInto(OTHER, "msg_recorded_turn_b"),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: OTHER }),
      ]);
      const other = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
        nativeThreadRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: OTHER,
          strength: "strong" as const,
        },
      };
      yield* runtime.resumeThread({
        providerThread: other,
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      let ended = 0;
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal" && ++ended === 2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.startTurn(turnInput(other));
      assert.deepEqual(
        [...(yield* Fiber.join(collected))].flatMap((event) =>
          event.type === "provider_session.updated" ? [event.providerSession.status] : [],
        ),
        ["running", "ready"],
      );
    }),
  );

  it.effect.each([
    ["refuses a rollback while a timed-out Stop's run is still going", true],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const prompt = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: prompt, time: { created: 1 }, text: "hi", type: "user" }],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: prompt,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: prompt, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", { data: [], cursor: {} }),
            ]),
      ]);
      yield* stopFirstTurn(runtime, thread);
      const now = yield* DateTime.now;
      const first = {
        id: yield* providerTurnId,
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:opencode2-adapter"),
        runAttemptId: RunAttemptId.make("attempt:opencode2-adapter"),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: prompt,
          strength: "weak" as const,
        },
        ordinal: 1,
        status: "interrupted" as const,
        startedAt: now,
        completedAt: now,
      };
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [first],
        })
        .pipe(Effect.exit);
      if (running) {
        assert.isTrue(Exit.isFailure(rollback));
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("takes back a stranded steer again when its first cancel failed", () =>
    Effect.gen(function* () {
      const steerId = `msg_t3_steer_${SESSION}:message:opencode2-adapter:steer`;
      const cancelOut = out("session.inbox.cancel", { sessionID: SESSION, inboxID: steerId });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        out("session.prompt", {
          sessionID: SESSION,
          id: steerId,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: steerId,
          sessionID: SESSION,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        event("session.execution.interrupted", { sessionID: SESSION }),
        cancelOut,
        reply("session.inbox.cancel", {
          status: 500,
          body: { _tag: "UnknownError", message: "busy" },
        }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        cancelOut,
        reply("session.inbox.cancel", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const seen: Array<string> = [];
      const ended = yield* Deferred.make<void>();
      const nextEnded = yield* Deferred.make<void>();
      // One consumer reads every terminal; a second reader would race it for the queue.
      const thirdEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type !== "turn.terminal") return;
            seen.push(event.status);
            if (seen.length === 1) yield* Deferred.succeed(ended, undefined);
            if (seen.length === 2) yield* Deferred.succeed(nextEnded, undefined);
            if (seen.length === 3) yield* Deferred.succeed(thirdEnded, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.steerTurn({
        threadId,
        runId: RunId.make("run:opencode2-adapter"),
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        message: {
          ...turnInput(thread).message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "Also say STEERED.",
        },
      });
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      yield* Deferred.await(ended);
      yield* runtime.startTurn(secondTurn(thread));
      yield* Deferred.await(nextEnded);
      yield* runtime.startTurn({
        ...secondTurn(thread),
        runId: RunId.make("run:opencode2-adapter:3"),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        attemptId: RunAttemptId.make("attempt:opencode2-adapter:3"),
      });
      yield* Deferred.await(thirdEnded);
    }),
  );

  it.effect("drops the turns a rollback cut from the snapshot it returns", () =>
    Effect.gen(function* () {
      const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
      const dropped = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter:2`;
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: kept, time: { created: 1 }, text: "first", type: "user" }],
          cursor: {},
        }),
      ]);
      const turns: Array<OrchestrationV2ProviderTurn> = [];
      const firstEnded = yield* Deferred.make<void>();
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status !== "running") {
              turns.push(event.providerTurn);
              if (turns.length === 1) yield* Deferred.succeed(firstEnded, undefined);
              if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(firstEnded);
      yield* runtime.startTurn(secondTurn(thread));
      yield* Deferred.await(bothEnded);
      const [first, second] = turns;
      const snapshot = yield* runtime.rollbackThread({
        providerThread: thread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:first"),
          appRunOrdinal: 1,
          providerTurn: first!,
        },
        providerThreadTurns: [first!, second!],
      });
      assert.deepEqual(
        snapshot.providerTurns.map((turn) => turn.id),
        [first!.id],
      );
    }),
  );

  it.effect("starts a turn sent during a rollback only once the cut is made", () =>
    Effect.gen(function* () {
      const prompted = `msg_t3_turn_${SESSION}:attempt:earlier`;
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: prompted, time: { created: 1 }, text: "earlier", type: "user" }],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: prompted, files: false }),
        replyData("session.revert.stage", { messageID: prompted, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", { data: [], cursor: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const now = yield* DateTime.now;
      const earlier = {
        id: ProviderTurnId.make("provider-turn:earlier"),
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:earlier"),
        runAttemptId: RunAttemptId.make("attempt:earlier"),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId: prompted, strength: "weak" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [earlier],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.startTurn({ ...turnInput(thread), providerTurnOrdinal: 1 });
      yield* Fiber.join(rollback);
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect.each([
    [
      "keeps the recorded turns before the target when rolling back a session not loaded yet",
      false,
    ],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const first = `msg_t3_turn_${SESSION}:attempt:first`;
      const second = `msg_t3_turn_${SESSION}:attempt:second`;
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("session.get", { sessionID: SESSION }),
              replyData("session.get", sessionInfo()),
              ...noOpenRequests,
              out("message.list", "<any>"),
              reply("message.list", {
                data: [
                  { id: second, time: { created: 2 }, text: "second", type: "user" },
                  { id: first, time: { created: 1 }, text: "first", type: "user" },
                ],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: second,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: second, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: first, time: { created: 1 }, text: "first", type: "user" }],
                cursor: {},
              }),
            ]),
      ]);
      const thread = providerThread(yield* DateTime.now);
      const now = yield* DateTime.now;
      const recorded = (key: string, ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`provider-turn:${key}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${key}`),
        runAttemptId: RunAttemptId.make(`attempt:${key}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const kept = recorded("first", 1, first);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: kept,
          },
          providerThreadTurns: [kept, recorded("second", 2, second)],
        })
        .pipe(Effect.exit);
      if (running) {
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
        assert.deepEqual(
          Exit.isSuccess(rollback) ? rollback.value.providerTurns.map((turn) => turn.id) : [],
          [kept.id],
        );
      }
    }),
  );

  it.effect("refuses to fork a session while OpenCode runs a follow-up on it", () =>
    Effect.gen(function* () {
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        event("session.execution.started", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      yield* Deferred.await(offered);
      const refused = yield* runtime
        .forkThread({
          sourceProviderThread: thread,
          targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterProtocolError");
    }),
  );

  // regression: #24549 a Stop whose interrupted event never arrives blocked the next fork
  it.effect("forks a stopped session whose interrupted event never arrived", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.fork", { sessionID: SESSION }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", { sessionID: FORK, permissions: "<any>" }),
        reply("session.update", null),
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.interrupted", { sessionID: SESSION }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.failed", {
          sessionID: SESSION,
          error: { type: "provider", message: "second turn failed" },
        }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
      // The lost end arriving late must not finish the source's next turn.
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "interrupted");
      assert.equal(second?.failure?.message, "second turn failed");
    }),
  );

  it.effect("refuses to fork a stopped session OpenCode still runs", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        out("session.active"),
        reply("session.active", { data: { [SESSION]: { type: "running" } } }),
      ]);
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      const refused = yield* runtime
        .forkThread({
          sourceProviderThread: thread,
          targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterProtocolError");
    }),
  );

  it.effect("moves a fork into its target thread's worktree before the first prompt", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const target = "/work/opencode2-fork-target";
      const { runtime, thread } = yield* resumed([
        out("session.fork", { sessionID: SESSION }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", {
          sessionID: FORK,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "t3-code-*", resource: "*", effect: "deny" },
            { action: "t3-code-thread_opencode2-adapter_fork_*", resource: "*", effect: "allow" },
          ],
        }),
        reply("session.update", null),
        // OpenCode makes the fork where its source runs; the target thread runs elsewhere.
        out("session.move", { sessionID: FORK, directory: target }),
        reply("session.move", null),
      ]);
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        runtimePolicy: { ...policy(), cwd: target },
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
    }),
  );

  const continued = (after: ReadonlyArray<ProviderReplayEntry>, external?: string) =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        ...(external === undefined
          ? []
          : [
              event("session.inbox.enqueued", {
                inboxID: external,
                sessionID: SESSION,
                item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
              }),
            ]),
        event("session.inbox.enqueued", {
          inboxID: "msg_report",
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: CONTINUED_REPORT,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: CHILD,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        ...(external === undefined
          ? []
          : [event("session.inbox.delivered", { sessionID: SESSION, inboxID: external })]),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_followup",
          ordinal: 0,
          text: "CHILD_OK",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        ...after,
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => void offers.push(request)).pipe(
              Effect.andThen(Deferred.succeed(offered, undefined)),
              Effect.asVoid,
            ),
          take: Effect.never,
        }),
      );
      const turns: Array<OrchestrationV2ProviderTurn> = [];
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status !== "running") {
              turns.push(event.providerTurn);
              if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(offered);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      yield* Deferred.await(bothEnded);
      const [first, second] = turns;
      return { runtime, thread, first: first!, second: second! };
    });
  const CONTINUED_PROMPT = `msg_t3_turn_${SESSION}:attempt:attempt:opencode2-adapter`;
  const CONTINUED_REPORT = `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`;
  const continuedHistory = {
    data: [
      { id: "msg_report", time: { created: 2 }, text: CONTINUED_REPORT, type: "synthetic" },
      { id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" },
    ],
    cursor: {},
  };

  it.effect("forks before a continuation's report, so the fork leaves out its answer", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const { runtime, thread, first, second } = yield* continued([
        out("message.list", { sessionID: SESSION, limit: "100", type: "user" }),
        reply("message.list", { data: [continuedHistory.data[1]], cursor: {} }),
        out("message.list", { sessionID: SESSION, limit: "100", type: "synthetic" }),
        reply("message.list", {
          data: [
            { id: "msg_later_report", time: { created: 3 }, text: "later", type: "synthetic" },
          ],
          cursor: { next: "synthetic-page-2" },
        }),
        out("message.list", {
          sessionID: SESSION,
          limit: "100",
          type: "synthetic",
          cursor: "synthetic-page-2",
        }),
        reply("message.list", { data: [continuedHistory.data[0]], cursor: {} }),
        out("session.fork", { sessionID: SESSION, before: "msg_report" }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", { sessionID: FORK, permissions: "<any>" }),
        reply("session.update", null),
      ]);
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
        providerTurnId: first.id,
        sourceProviderTurns: [first, second],
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
    }),
  );

  it.effect(
    "reverts OpenCode at another client's prompt queued before a continuation's report",
    () =>
      Effect.gen(function* () {
        const { runtime, thread, first, second } = yield* continued(
          [
            out("message.list", "<any>"),
            reply("message.list", {
              data: [
                {
                  id: "msg_report",
                  time: { created: 3 },
                  text: CONTINUED_REPORT,
                  type: "synthetic",
                },
                { id: "msg_external", time: { created: 2 }, text: "qwe!", type: "user" },
                { id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" },
              ],
              cursor: {},
            }),
            out("session.revert.stage", {
              sessionID: SESSION,
              messageID: "msg_external",
              files: false,
            }),
            replyData("session.revert.stage", { messageID: "msg_external", files: [] }),
            out("session.revert.commit", { sessionID: SESSION }),
            reply("session.revert.commit", null),
            out("message.list", "<any>"),
            reply("message.list", {
              data: [{ id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" }],
              cursor: {},
            }),
          ],
          "msg_external",
        );
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first,
          },
          providerThreadTurns: [first, second],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first.id],
        );
      }),
  );

  it.effect("keeps a subagent a stopped background reply started off the next turn", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const SPAWNED = "ses_f1485c529ffeDDDDDDDDDDDDDD";
      const NESTED = "ses_f1485c529ffeNNNNNNNNNNNNNN";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const spawn = { sessionID: SESSION, assistantMessageID: "msg_reply", id: "call-spawn" };
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const gate = makeProviderReplayGate(["settled"]);
      const { runtime, thread } = yield* resumed(
        [
          ...backgroundLaunch(CHILD),
          event("session.tool.input.started", { ...toolB, name: "subagent" }),
          event("session.tool.called", {
            ...toolB,
            name: "subagent",
            input: { description: "Sleep", prompt: "sleep", background: true },
            executed: false,
          }),
          event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
          event("session.tool.progress", {
            ...toolB,
            metadata: { sessionID: CHILD_B, status: "running" },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.started", { sessionID: CHILD_B }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.tool.input.started", { ...spawn, name: "subagent" }),
          event("session.tool.called", {
            ...spawn,
            name: "subagent",
            input: { description: "Sleep", prompt: "sleep", background: true },
            executed: false,
          }),
          event("session.created", { ...childCreated(SPAWNED), sessionID: SPAWNED }),
          event("session.tool.progress", {
            ...spawn,
            metadata: { sessionID: SPAWNED, status: "running" },
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.text.ended", {
            sessionID: CHILD_B,
            assistantMessageID: "msg_child_b",
            ordinal: 0,
            text: "B_WORKING",
          }),
          out("session.interrupt", { sessionID: CHILD_B }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: CHILD_B }),
          out("session.interrupt", { sessionID: SPAWNED }),
          reply("session.interrupt", {
            status: 500,
            body: { _tag: "UnknownError", message: "interrupt failed" },
          }),
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          event("permission.asked", { ...shellAsk.data, id: "per_spawned", sessionID: SPAWNED }),
          out("permission.reply", {
            sessionID: SPAWNED,
            requestID: "per_spawned",
            decision: "reject",
          }),
          reply("permission.reply", null),
          event("session.created", {
            ...childCreated(NESTED),
            sessionID: NESTED,
            parentID: SPAWNED,
          }),
          event("permission.asked", { ...shellAsk.data, id: "per_nested", sessionID: NESTED }),
          out("permission.reply", {
            sessionID: NESTED,
            requestID: "per_nested",
            decision: "reject",
          }),
          reply("permission.reply", null),
          event("session.text.ended", {
            sessionID: SESSION,
            assistantMessageID: "msg_unrelated",
            ordinal: 0,
            text: "UNRELATED",
          }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("session.interrupt", { sessionID: SPAWNED }),
          reply("session.interrupt", { interrupted: true }),
          out("session.interrupt", { sessionID: NESTED }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: SPAWNED }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report_spawned",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: `<subagent sessionID="${SPAWNED}" state="cancelled" description="Sleep">\n</subagent>`,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: SPAWNED,
                  agent: "General",
                  state: "cancelled",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          out("session.interrupt", { sessionID: SESSION }),
          reply("session.interrupt", { interrupted: true }),
          event("session.execution.interrupted", { sessionID: SESSION }, "settled"),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const replyEnded = yield* Deferred.make<void>();
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
              if (event.turnItem.text === "B_WORKING")
                yield* Deferred.succeed(replyEnded, undefined);
            }
            if (collected.filter((entry) => entry.type === "turn.terminal").length === 2) {
              yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(replyEnded);
      assert.lengthOf(offers, 1);
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* runtime.startTurn({ ...secondTurn(thread), appThread: withLineage(thread).appThread });
      yield* Deferred.await(bothEnded);
      for (let stops = 0; stops < 2; stops++) {
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
      }
      yield* Effect.promise(() => gate.waitForReached("settled"));
      gate.release("settled");
      assert.lengthOf(offers, 1);
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "runtime_request.updated"
            ? [`${event.runtimeRequest.nativeRequestRef?.nativeId}:${event.runtimeRequest.status}`]
            : [],
        ),
        [],
      );
    }),
  );

  // regression: #14752 continuations replayed background replies that were not theirs
  it.effect("ends a continuation while a skipped reply's subagent does not answer its Stop", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const SPAWNED = "ses_f1485c529ffeDDDDDDDDDDDDDD";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const spawn = { sessionID: SESSION, assistantMessageID: "msg_reply_a", id: "call-spawn" };
      const report = (inboxID: string, child: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: `<subagent sessionID="${child}" state="completed" description="Sleep">\nOK\n</subagent>`,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: child,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        });
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const bothOffered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.tool.input.started", { ...toolB, name: "subagent" }),
        event("session.tool.called", {
          ...toolB,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
        event("session.tool.progress", {
          ...toolB,
          metadata: { sessionID: CHILD_B, status: "running" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        report("msg_report_a", CHILD),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.tool.input.started", { ...spawn, name: "subagent" }),
        event("session.tool.called", {
          ...spawn,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(SPAWNED), sessionID: SPAWNED }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD_B }),
        report("msg_report_b", CHILD_B),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_reply_b",
          ordinal: 0,
          text: "REPLY_B",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.interrupt", { sessionID: SPAWNED }),
        reply("session.interrupt", "<hang>"),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.suspend(() =>
              offers.push(request) === 2
                ? Deferred.succeed(bothOffered, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          take: Effect.never,
        }),
      );
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(bothOffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[1]!, "wake-b"));
      assert.deepEqual(
        [...(yield* Fiber.join(ended))].map((terminal) => terminal.status),
        ["completed", "completed"],
      );
    }),
  );

  it.effect("replays only its own background reply into a continuation turn", () =>
    Effect.gen(function* () {
      const CHILD_B = "ses_f1485c529ffeBBBBBBBBBBBBBB";
      const toolB = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-b" };
      const report = (inboxID: string, child: string, text: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: `<subagent sessionID="${child}" state="completed" description="Sleep">\n${text}\n</subagent>`,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: child,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        });
      const reply = (assistantMessageID: string, text: string) =>
        event("session.text.ended", { sessionID: SESSION, assistantMessageID, ordinal: 0, text });
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const bothOffered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.tool.input.started", { ...toolB, name: "subagent" }),
        event("session.tool.called", {
          ...toolB,
          name: "subagent",
          input: { description: "Sleep", prompt: "sleep", background: true },
          executed: false,
        }),
        event("session.created", { ...childCreated(CHILD_B), sessionID: CHILD_B }),
        event("session.tool.progress", {
          ...toolB,
          metadata: { sessionID: CHILD_B, status: "running" },
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        report("msg_report_a", CHILD, "A_OK"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report_a" }),
        reply("msg_reply_a", "REPLY_A"),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD_B }),
        report("msg_report_b", CHILD_B, "B_OK"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report_b" }),
        reply("msg_reply_b", "REPLY_B"),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.suspend(() =>
              offers.push(request) === 2
                ? Deferred.succeed(bothOffered, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const ended = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (collected.filter((entry) => entry.type === "turn.terminal").length === 2) {
              yield* Deferred.succeed(ended, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(bothOffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[1]!, "wake-b"));
      yield* Deferred.await(ended);
      const continuationId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: OPENCODE_PROVIDER,
        nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter:wake-b`,
      });
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.providerTurnId === continuationId
            ? [event.turnItem.text]
            : [],
        ),
        ["REPLY_B"],
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );

  it.effect(
    "reverts a report's continuation at its report after a Stop dropped another client's prompt",
    () =>
      Effect.gen(function* () {
        const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
        const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
        const reportOffered = yield* Deferred.make<void>();
        const { runtime, thread } = yield* resumed([
          event("session.inbox.enqueued", {
            inboxID: "msg_stale",
            sessionID: SESSION,
            item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_stale" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { id: "buffered", providerID: "opencode" },
          }),
          out("session.switchModel", { sessionID: SESSION, model: "<any>" }),
          reply("session.switchModel", null),
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: CONTINUED_REPORT,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: "msg_report", time: { created: 3 }, text: CONTINUED_REPORT, type: "synthetic" },
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
          out("session.revert.stage", {
            sessionID: SESSION,
            messageID: "msg_report",
            files: false,
          }),
          replyData("session.revert.stage", { messageID: "msg_report", files: [] }),
          out("session.revert.commit", { sessionID: SESSION }),
          reply("session.revert.commit", null),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
        ]).pipe(
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: (request) =>
              Effect.sync(() => void offers.push(request)).pipe(
                Effect.andThen(() =>
                  offers.length === 2 ? Deferred.succeed(reportOffered, undefined) : Effect.void,
                ),
                Effect.asVoid,
              ),
            take: Effect.never,
          }),
        );
        const turns: Array<OrchestrationV2ProviderTurn> = [];
        const buffered = yield* Deferred.make<void>();
        const bothEnded = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
              ) {
                yield* Deferred.succeed(buffered, undefined);
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.status !== "running"
              ) {
                turns.push(event.providerTurn);
                if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(buffered);
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* runtime.startTurn(withLineage(thread));
        yield* Deferred.await(reportOffered);
        yield* runtime.startTurn(continuationTurn(thread, offers[1]!));
        yield* Deferred.await(bothEnded);
        const [first, continuation] = turns;
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first!,
          },
          providerThreadTurns: [first!, continuation!],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first!.id],
        );
      }),
  );

  it.effect(
    "reverts a report's continuation at its report after a reconnect lost another client's prompt start",
    () =>
      Effect.gen(function* () {
        const kept = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
        const offered =
          yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
        const { runtime, thread } = yield* resumed([
          event("session.inbox.enqueued", {
            inboxID: "msg_stale",
            sessionID: SESSION,
            item: { type: "user", payload: { text: "qwe!", files: [] }, delivery: "steer" },
          }),
          { type: "runtime_exit", status: "success" } as const,
          out("event.subscribe"),
          event("session.model.selected", {
            sessionID: SESSION,
            model: { id: "buffered", providerID: "opencode" },
          }),
          out("session.switchModel", { sessionID: SESSION, model: "<any>" }),
          reply("session.switchModel", null),
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          event("session.inbox.enqueued", {
            inboxID: "msg_report",
            sessionID: SESSION,
            item: {
              type: "synthetic",
              payload: {
                text: CONTINUED_REPORT,
                description: "Sleep",
                metadata: {
                  source: "subagent",
                  childID: CHILD,
                  agent: "General",
                  state: "completed",
                },
              },
              delivery: "steer",
            },
          }),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: "msg_report", time: { created: 3 }, text: CONTINUED_REPORT, type: "synthetic" },
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
          out("session.revert.stage", {
            sessionID: SESSION,
            messageID: "msg_report",
            files: false,
          }),
          replyData("session.revert.stage", { messageID: "msg_report", files: [] }),
          out("session.revert.commit", { sessionID: SESSION }),
          reply("session.revert.commit", null),
          out("message.list", "<any>"),
          reply("message.list", {
            data: [
              { id: kept, time: { created: 2 }, text: "hi", type: "user" },
              { id: "msg_stale", time: { created: 1 }, text: "qwe!", type: "user" },
            ],
            cursor: {},
          }),
        ]).pipe(
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
            take: Effect.never,
          }),
        );
        const turns: Array<OrchestrationV2ProviderTurn> = [];
        const reconnected = yield* Deferred.make<void>();
        const bothEnded = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (
                event.type === "provider_thread.updated" &&
                event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
              ) {
                yield* Deferred.succeed(reconnected, undefined);
              }
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.status !== "running"
              ) {
                turns.push(event.providerTurn);
                if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Deferred.await(reconnected);
        yield* runtime.startTurn(withLineage(thread));
        yield* runtime.startTurn(continuationTurn(thread, yield* Deferred.await(offered)));
        yield* Deferred.await(bothEnded);
        const [first, continuation] = turns;
        const snapshot = yield* runtime.rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: first!,
          },
          providerThreadTurns: [first!, continuation!],
        });
        assert.deepEqual(
          snapshot.providerTurns.map((turn) => turn.id),
          [first!.id],
        );
      }),
  );

  it.effect("shows a second prompt another client sent while its continuation was pending", () =>
    Effect.gen(function* () {
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const prompt = (inboxID: string, text: string) =>
        event("session.inbox.enqueued", {
          inboxID,
          sessionID: SESSION,
          item: { type: "user", payload: { text, files: [] }, delivery: "steer" },
        });
      // T3's own prompt can be admitted after a failed submit ended its turn.
      const late = `msg_t3_turn_${SESSION}:attempt:late`;
      const { runtime, thread } = yield* resumed([
        prompt(late, "mine"),
        prompt("msg_external_a", "first?"),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: late }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_external_a" }),
        prompt("msg_external_b", "second?"),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_external_b" }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_external_reply",
          ordinal: 0,
          text: "Both!",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        // Handled only after the wake above has buffered everything before it.
        event("session.model.selected", {
          sessionID: SESSION,
          model: { id: "buffered", providerID: "opencode" },
        }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Effect.sync(() => void offers.push(request)),
          take: Effect.never,
        }),
      );
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const buffered = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.modelSelection?.model === "opencode/buffered"
            ) {
              yield* Deferred.succeed(buffered, undefined);
            }
            if (event.type === "turn.terminal") yield* Deferred.succeed(ended, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Deferred.await(buffered);
      yield* runtime.startTurn(continuationTurn(thread, offers[0]!));
      yield* Deferred.await(ended);
      assert.deepEqual(
        collected.flatMap((event) =>
          event.type === "turn_item.updated" &&
          (event.turnItem.type === "user_message" || event.turnItem.type === "assistant_message")
            ? [`${event.turnItem.type}: ${event.turnItem.text}`]
            : [],
        ),
        ["user_message: first?", "user_message: second?", "assistant_message: Both!"],
      );
      assert.deepEqual(
        [
          ...new Set(
            collected.flatMap((event) =>
              event.type === "message.updated"
                ? [`${event.message.role}: ${event.message.text}`]
                : [],
            ),
          ),
        ],
        ["user: first?", "user: second?", "assistant: Both!"],
      );
    }),
  );

  it.effect("shows a question asked while OpenCode wakes for a background reply", () =>
    Effect.gen(function* () {
      const OTHER = "ses_other00000000000000000000";
      const gate = makeProviderReplayGate(["continued"]);
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const { runtime, thread } = yield* resumed(
        [
          out("session.get", { sessionID: OTHER }),
          replyData("session.get", sessionInfo({ id: OTHER })),
          out("permission.list", { sessionID: OTHER }),
          replyData("permission.list", []),
          out("session.form.list", { sessionID: OTHER }),
          replyData("session.form.list", []),
          ...backgroundLaunch(CHILD),
          event("session.execution.succeeded", { sessionID: SESSION }),
          event("session.execution.succeeded", { sessionID: CHILD }),
          childReport("msg_report", "CHILD_OK"),
          event("session.execution.started", { sessionID: SESSION }),
          event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
          event("form.created", { form: colorForm }),
          // Handled after the form, so its update proves the form reached the adapter.
          event("session.model.selected", {
            sessionID: OTHER,
            model: { providerID: "opencode", id: "big-pickle", variant: "none" },
          }),
          // Released once the continuation started, so its update follows the replay.
          event(
            "session.model.selected",
            {
              sessionID: OTHER,
              model: { providerID: "opencode", id: "big-pickle", variant: "thinking" },
            },
            "continued",
          ),
          out("session.form.reply", {
            sessionID: SESSION,
            formID: colorForm.id,
            answer: { q0: "Red" },
          }),
          reply("session.form.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { replayGate: gate },
      ).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => Deferred.succeed(offered, request).pipe(Effect.asVoid),
          take: Effect.never,
        }),
      );
      yield* runtime.resumeThread({
        providerThread: {
          ...thread,
          id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
          nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: OTHER, strength: "strong" },
        },
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const collected: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const formSeen = yield* Deferred.make<void>();
      const replayed = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      const otherVariant = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeThreadRef?.nativeId === OTHER
          ? event.providerThread.nativeMetadata?.modelSelection?.options?.[0]?.value
          : undefined;
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            collected.push(event);
            if (otherVariant(event) === "none") yield* Deferred.succeed(formSeen, undefined);
            if (otherVariant(event) === "thinking") yield* Deferred.succeed(replayed, undefined);
            if (collected.filter((entry) => entry.type === "turn.terminal").length === 2) {
              yield* Deferred.succeed(ended, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      const offer = yield* Deferred.await(offered);
      yield* Deferred.await(formSeen);
      yield* runtime.startTurn(continuationTurn(thread, offer));
      gate.release("continued");
      yield* Deferred.await(replayed);
      const requests = collected.flatMap((event) =>
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? [event.runtimeRequest]
          : [],
      );
      assert.deepEqual(
        requests.map((request) => request.nativeRequestRef?.nativeId),
        [colorForm.id],
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: requests[0]!.id,
        answers: { q0: "Red" },
      });
      yield* Deferred.await(ended);
      const last = collected.findLast((event) => event.type === "turn.terminal");
      assert.equal(last?.type === "turn.terminal" ? last.status : undefined, "completed");
    }),
  );

  it.effect("ends a follow-up turn a steer joined exactly once", () =>
    Effect.gen(function* () {
      const reportText = `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`;
      const steerId = `msg_t3_steer_${SESSION}:message:opencode2-adapter:steer`;
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const offered = yield* Deferred.make<void>();
      const { runtime, thread } = yield* resumed([
        ...backgroundLaunch(CHILD),
        event("session.execution.succeeded", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: CHILD }),
        event("session.inbox.enqueued", {
          inboxID: "msg_report",
          sessionID: SESSION,
          item: {
            type: "synthetic",
            payload: {
              text: reportText,
              description: "Sleep",
              metadata: {
                source: "subagent",
                childID: CHILD,
                agent: "General",
                state: "completed",
              },
            },
            delivery: "steer",
          },
        }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: "msg_report" }),
        out("session.prompt", {
          sessionID: SESSION,
          id: steerId,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: steerId,
          sessionID: SESSION,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_followup",
          ordinal: 0,
          text: "CHILD_OK STEERED",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]).pipe(
        Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) =>
            Effect.sync(() => void offers.push(request)).pipe(
              Effect.andThen(Deferred.succeed(offered, undefined)),
              Effect.asVoid,
            ),
          take: Effect.never,
        }),
      );
      const terminals: Array<string> = [];
      const followUpEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type !== "turn.terminal") return;
            terminals.push(event.status);
            if (terminals.length === 2) yield* Deferred.succeed(followUpEnded, undefined);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(withLineage(thread));
      yield* Deferred.await(offered);
      const followUp = continuationTurn(thread, offers[0]!);
      yield* runtime.startTurn(followUp);
      const followUpTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: OPENCODE_PROVIDER,
        nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter:wake`,
      });
      yield* runtime.steerTurn({
        threadId,
        runId: followUp.runId,
        providerThread: thread,
        providerTurnId: followUpTurnId,
        message: {
          ...turnInput(thread).message,
          messageId: MessageId.make("message:opencode2-adapter:steer"),
          text: "Also say STEERED.",
        },
      });
      yield* Deferred.await(followUpEnded);
      yield* Effect.yieldNow;
      assert.deepEqual(terminals, ["completed", "completed"]);
      assert.lengthOf(offers, 1);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );
  it.effect.each(["", "pause", "clear", "resume", "Write proof.txt"])(
    "preserves older OpenCode goal command execution for /goal %s",
    (control) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("command.list", "<any>"),
            reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
            out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
            reply("message.list", { data: [], cursor: {} }),
            out("session.command", { sessionID: SESSION, name: "goal", text: control }),
            reply("session.command", null),
            event("session.text.ended", {
              sessionID: SESSION,
              assistantMessageID: "msg_legacy_goal",
              ordinal: 0,
              text: "Legacy command finished",
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { goal: { objective: "Saved before downgrade", status: "active" } },
        );
        assert.isFalse(runtime.providerSession.capabilities.turns.supportsNativeGoals);
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: `/goal ${control}`.trim() },
        });
        const collected = yield* Fiber.join(events);
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "assistant_message" &&
              e.turnItem.text === "Legacy command finished",
          ),
        );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }),
  );

  // regression: #35872
  it.effect("completes /goal clear when OpenCode has no goal to clear", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("command.list", "<any>"),
          reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
          out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
          reply("message.list", { data: [], cursor: {} }),
          out("session.command", { sessionID: SESSION, name: "goal", text: "clear" }),
          reply("session.command", {
            status: 500,
            body: { _tag: "CommandExecutionError", command: "goal", message: "No goal is set." },
          }),
        ],
        { version: "2.2.5" },
      );
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const input = turnInput(thread);
      yield* runtime.startTurn({ ...input, message: { ...input.message, text: "/goal clear" } });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("reads an existing OpenCode 2.2.5 goal when resuming a session", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntime(
        [
          ...opening,
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          ...noOpenRequests,
          out("rpc.call", {
            rpcID: "opencode.goal",
            method: "get",
            "location[directory]": WORK,
            input: { sessionID: SESSION },
          }),
          reply("rpc.call", { output: nativeGoal("paused") }),
          ...emptyShellInventory,
        ],
        { version: "2.2.5" },
      );
      assert.isTrue(runtime.providerSession.capabilities.turns.supportsNativeGoals);
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      assert.deepEqual(thread.goal, {
        objective: "Write proof.txt",
        status: "paused",
        checks: 2,
        lastCheck: "Checked proof.txt",
      });
    }),
  );

  it.effect.each([
    { status: "complete", reconnect: false },
    { status: "paused", reconnect: false },
    { status: "complete", reconnect: true },
  ] as const)(
    "keeps an OpenCode goal turn open until $status, with reconnect $reconnect",
    ({ status, reconnect }) =>
      Effect.gen(function* () {
        const recovered = reconnected({ [SESSION]: { type: "running" } });
        const { runtime, thread } = yield* resumed(
          [
            out("command.list", "<any>"),
            reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
            out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
            reply("message.list", { data: [], cursor: {} }),
            out("session.command", { sessionID: SESSION, name: "goal", text: "Write proof.txt" }),
            reply("session.command", null),
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("active") }),
            event("session.execution.succeeded", { sessionID: SESSION }),
            ...(status === "complete"
              ? reconnect
                ? [
                    ...recovered.slice(0, 2),
                    out("rpc.call", "<any>"),
                    reply("rpc.call", { output: nativeGoal("active") }),
                    ...emptyShellInventory,
                    ...recovered.slice(2),
                    ...noOpenRequests,
                  ]
                : [event("session.execution.started", { sessionID: SESSION })]
              : []),
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal(status) }),
            ...(status === "complete"
              ? [
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_goal_final",
                    ordinal: 0,
                    text: "Final goal output",
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : []),
          ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: "/goal Write proof.txt" },
        });
        const collected = yield* Fiber.join(events);
        const goals = collected.flatMap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.goal
            ? [e.providerThread.goal]
            : [],
        );
        assert.includeDeepMembers(goals, [
          {
            objective: "Write proof.txt",
            status: "active",
            checks: 2,
            lastCheck: "Checked proof.txt",
          },
          {
            objective: "Write proof.txt",
            status,
            checks: 2,
            lastCheck: "Checked proof.txt",
          },
        ]);
        if (status === "complete")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Final goal output",
            ),
          );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }),
  );

  it.effect("does not replace a newer goal event with an older goal RPC response", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["release-goal-read"]);
      const { runtime, thread } = yield* resumed(
        [
          out("rpc.call", "<any>"),
          event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("paused") }),
          event(
            "rpc.opencode.goal.changed",
            { sessionID: SESSION, goal: nativeGoal("paused") },
            "release-goal-read",
          ),
          reply("rpc.call", { output: nativeGoal("active") }),
        ],
        { version: "2.2.5", replayGate: gate },
      );
      const changed = yield* Deferred.make<void>();
      const events = yield* runtime.events.pipe(
        Stream.tap((e) =>
          e.type === "provider_thread.updated" && e.providerThread.goal?.status === "paused"
            ? Deferred.succeed(changed, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const input = turnInput(thread);
      const starting = yield* runtime
        .startTurn({ ...input, message: { ...input.message, text: "/goal" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(changed);
      gate.release("release-goal-read");
      yield* Fiber.join(starting);
      const collected = yield* Fiber.join(events);
      const updated = collected.findLast((e) => e.type === "provider_thread.updated");
      assert.equal(
        updated?.type === "provider_thread.updated"
          ? updated.providerThread.goal?.status
          : undefined,
        "paused",
      );
    }),
  );

  it.effect.each(["unreadable", "stalled"] as const)(
    "settles a completed execution after reconnect when goal refresh is %s",
    (failure) =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["goal-refresh-stalled"]);
        const reconnect = reconnected({}, "succeeded");
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal("active") }),
            ...reconnect.slice(0, 2),
            out("rpc.call", "<any>"),
            reply("rpc.call", failure === "stalled" ? "<hang>" : { output: { unreadable: true } }),
            ...(failure === "stalled"
              ? [
                  event(
                    "rpc.opencode.goal.changed",
                    { sessionID: SESSION, goal: null },
                    "goal-refresh-stalled",
                  ),
                ]
              : []),
            ...emptyShellInventory,
            ...reconnect.slice(2),
          ],
          { version: "2.2.5", replayGate: gate },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        if (failure === "stalled") {
          yield* Effect.promise(() => gate.waitForReached("goal-refresh-stalled"));
          gate.release("goal-refresh-stalled");
          yield* TestClock.adjust("5 seconds");
        }
        const collected = yield* Fiber.join(events);
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }),
  );

  it.effect.each([
    { initial: "active", recovered: "paused" },
    { initial: "paused", recovered: "active" },
    { initial: "active", recovered: "unreadable" },
  ] as const)(
    "recovers unreadable native goal updates when cached goal is $initial and RPC returns $recovered",
    ({ initial, recovered }) =>
      Effect.gen(function* () {
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            event("rpc.opencode.goal.changed", { sessionID: SESSION, goal: nativeGoal(initial) }),
            event("rpc.opencode.goal.changed", {
              sessionID: SESSION,
              goal: { ...nativeGoal(initial), status: "unknown" },
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
            out("rpc.call", "<any>"),
            reply("rpc.call", { output: recovered === "unreadable" ? {} : nativeGoal(recovered) }),
            ...(recovered === "active"
              ? [
                  event("session.execution.started", { sessionID: SESSION }),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_recovered_goal",
                    ordinal: 0,
                    text: "Continued work",
                  }),
                  event("rpc.opencode.goal.changed", {
                    sessionID: SESSION,
                    goal: nativeGoal("complete"),
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : []),
          ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        const collected = yield* Fiber.join(events);
        const updated = collected.findLast((e) => e.type === "provider_thread.updated");
        assert.equal(
          updated?.type === "provider_thread.updated"
            ? updated.providerThread.goal?.status
            : undefined,
          recovered === "active" ? "complete" : recovered === "paused" ? "paused" : "active",
        );
        if (recovered === "active")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Continued work",
            ),
          );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }),
  );

  it.effect.each(["show", "pause", "clear"] as const)(
    "a delayed /goal %s response cannot finish its replacement turn",
    (control) =>
      Effect.gen(function* () {
        const operation = control === "show" ? "rpc.call" : "session.command";
        const { runtime, thread } = yield* resumed(
          [
            ...(control === "show"
              ? []
              : [
                  out("command.list", "<any>"),
                  reply("command.list", {
                    location: { directory: WORK },
                    data: [{ name: "goal" }],
                  }),
                  out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
                  reply("message.list", { data: [], cursor: {} }),
                ]),
            out(operation, "<any>"),
            event("session.execution.interrupted", { sessionID: SESSION, reason: "user" }),
            out("session.prompt", "<any>"),
            promptAccepted,
            reply(operation, control === "show" ? { output: nativeGoal("paused") } : null),
            event("session.text.ended", {
              sessionID: SESSION,
              assistantMessageID: "msg_replacement",
              ordinal: 0,
              text: "Replacement still tracked",
            }),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          { version: "2.2.5" },
        );
        const interrupted = yield* Deferred.make<void>();
        const events = yield* runtime.events.pipe(
          Stream.tap((e) =>
            e.type === "turn.terminal" && e.status === "interrupted"
              ? Deferred.succeed(interrupted, undefined)
              : Effect.void,
          ),
          Stream.takeUntil((e) => e.type === "turn.terminal" && e.status === "completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        const starting = yield* runtime
          .startTurn({
            ...input,
            message: { ...input.message, text: control === "show" ? "/goal" : `/goal ${control}` },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(interrupted);
        yield* runtime.startTurn({
          ...input,
          attemptId: RunAttemptId.make("replacement"),
          providerTurnOrdinal: 2,
        });
        yield* Fiber.join(starting);
        const collected = yield* Fiber.join(events);
        assert.isTrue(
          collected.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "assistant_message" &&
              e.turnItem.text === "Replacement still tracked",
          ),
        );
      }),
  );

  it.effect.each(["show", "pause", "clear"] as const)(
    "settles OpenCode /goal %s without waiting for an execution",
    (control) =>
      Effect.gen(function* () {
        const goal = control === "clear" ? null : nativeGoal("paused");
        const { runtime, thread } = yield* resumed(
          control === "show"
            ? [out("rpc.call", "<any>"), reply("rpc.call", { output: goal })]
            : [
                out("command.list", "<any>"),
                reply("command.list", { location: { directory: WORK }, data: [{ name: "goal" }] }),
                out("message.list", { sessionID: SESSION, order: "desc", limit: "1" }),
                reply("message.list", { data: [], cursor: {} }),
                out("session.command", { sessionID: SESSION, name: "goal", text: control }),
                event("rpc.opencode.goal.changed", { sessionID: SESSION, goal }),
                reply("session.command", null),
              ],
          { version: "2.2.5" },
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = turnInput(thread);
        yield* runtime.startTurn({
          ...input,
          message: { ...input.message, text: control === "show" ? "/goal" : `/goal ${control}` },
        });
        const collected = yield* Fiber.join(events);
        const updated = collected.findLast((e) => e.type === "provider_thread.updated");
        assert.equal(
          updated?.type === "provider_thread.updated"
            ? (updated.providerThread.goal?.status ?? null)
            : undefined,
          goal?.status ?? null,
        );
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      }),
  );
});

const providerTurnId = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  return ids.derive.providerTurn({
    driver: OPENCODE_PROVIDER,
    nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
  });
}).pipe(Effect.provide(IdAllocator.layer));
