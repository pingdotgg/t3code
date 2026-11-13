// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeURL from "node:url";
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

export const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";

export const WORK = "/work/opencode2";

export const instanceId = ProviderInstanceId.make("opencode");

export const threadId = ThreadId.make("thread:opencode2-adapter");

export const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});

export const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});

export const replyData = (operation: string, data: unknown) => reply(operation, { data });

export const event = (
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
      data,
      durable: { ...durable.durable, version },
    },
  },
  ...(label === undefined ? {} : { label }),
});

export const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

export const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];

export const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];

export const TITLE = "Prime check";

export const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
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

export const modelCatalog = {
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

export const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";

export const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

export const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

export const withInstructions = (
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

export const openCode2ReplayRuntimeWithInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: { readonly external?: boolean },
) => openCode2ReplayRuntime(withInstructions(entries), options);

export const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];

export const directoryModels = (directory: string): ReadonlyArray<ProviderReplayEntry> => [
  out("model.list", { "location[directory]": directory }),
  reply("model.list", { ...modelCatalog, location: { directory } }),
];

export const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };

export const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

export const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
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

export const turnInput = (
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

export const buildPaths = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];

export const agentList = {
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

export const supervisedRules = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...buildPaths,
  ...mcpRules,
];

export const shellAsk = {
  data: {
    id: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
    sessionID: SESSION,
    action: "shell",
    resources: ["echo FIRST"],
    save: ["echo *"],
    source: { type: "tool", messageID: "msg_0eb7c4330001dYFQKuTpfD780v", id: "call_1" },
  },
};

export const shellAskEvent = event("permission.asked", shellAsk.data);

export const colorForm = {
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

export const resumed = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly external?: boolean;
    readonly supervised?: boolean;
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly onPrompt?: (input: unknown) => void;
  },
) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      withInstructions([
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
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
      {
        ...(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
        ...(options?.onPrompt === undefined ? {} : { onPrompt: options.onPrompt }),
        ...(options?.external === undefined ? {} : { external: options.external }),
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
      providerThread: providerThread(yield* DateTime.now),
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(options?.supervised === true ? "approval-required" : "full-access"),
    });
    return { runtime, thread };
  });

export const requestOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
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

export const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
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

export const history = {
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

export const childCreated = (child: string) => ({
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

export const backgroundLaunch = (child: string): ReadonlyArray<ProviderReplayEntry> => {
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

export const withLineage = (thread: OrchestrationV2ProviderThread) => ({
  ...turnInput(thread),
  appThread: {
    id: threadId,
    title: TITLE,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  } as OrchestrationV2AppThread,
});

export const continuationTurn = (
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

export const CHILD = "ses_f1485c529ffea4URrYruwEg0Ja";

export const watchBackgroundTurn = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
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

export const returnedRunning = (id: string): ProviderReplayEntry => ({
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

export const callAgain = (input: Record<string, unknown>): ReadonlyArray<ProviderReplayEntry> => {
  const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-again" };
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
    out("session.update", { sessionID: CHILD, permissions: "<any>" }),
    reply("session.update", null),
    returnedRunning(tool.id),
  ];
};

export const childReport = (inboxID: string, text: string) =>
  event("session.inbox.enqueued", {
    inboxID,
    sessionID: SESSION,
    item: {
      type: "synthetic",
      payload: {
        text: `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\n${text}\n</subagent>`,
        description: "Sleep",
        metadata: { source: "subagent", childID: CHILD, agent: "General", state: "completed" },
      },
      delivery: "steer",
    },
  });

export const watchCalls = (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  thread: OrchestrationV2ProviderThread,
) =>
  Effect.gen(function* () {
    const calls = new Map<string, { status: string; result: string | null }>();
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
    return { calls, callsAtChildTurnStart, childTurns, state, until };
  });

export const launchedAndRunning = [
  ...backgroundLaunch(CHILD),
  returnedRunning("call-background"),
  event("session.execution.started", { sessionID: CHILD }),
];

export const MIDDLE = "ses_middle0000000000000000000";

export const DEEP = "ses_grandchild00000000000000";

export const toolOf = (session: string, id: string) => ({
  sessionID: session,
  assistantMessageID: `msg_assistant_${id}`,
  id,
});

export const deepReport = (state: "completed" | "cancelled") =>
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

export const nestedLaunch: ReadonlyArray<ProviderReplayEntry> = [
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

export const watchNested = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
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

export const stopTimedOut: ReadonlyArray<ProviderReplayEntry> = [
  out("session.prompt", { sessionID: SESSION, text: "<any>" }),
  promptAccepted,
  out("session.interrupt", { sessionID: SESSION }),
  reply("session.interrupt", "<hang>"),
];

export const secondTurn = (thread: OrchestrationV2ProviderThread) => ({
  ...turnInput(thread),
  runId: RunId.make("run:opencode2-adapter:2"),
  runOrdinal: 2,
  providerTurnOrdinal: 2,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
});

export const stopFirstTurn = (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  thread: OrchestrationV2ProviderThread,
) =>
  Effect.gen(function* () {
    yield* runtime.startTurn(turnInput(thread));
    const interrupt = yield* runtime
      .interruptTurn({ providerThread: thread, providerTurnId: yield* providerTurnId })
      .pipe(Effect.forkScoped);
    yield* TestClock.adjust("11 seconds");
    yield* Fiber.join(interrupt);
  });

export const terminals = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, count: number) =>
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

export const replyAfterUnclearFailure = (endedFirst: boolean) =>
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

export const reconnected = (
  active: Record<string, unknown>,
  ended?: "succeeded",
  assistant: Record<string, unknown> = {},
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

export const openRequests = (
  permissions: ReadonlyArray<unknown>,
  forms: ReadonlyArray<unknown> = [],
): ReadonlyArray<ProviderReplayEntry> => [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", permissions),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", forms),
];

export const turnItems = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  collected.flatMap((event) =>
    event.type === "turn_item.updated" ? [`${event.turnItem.type}:${event.turnItem.status}`] : [],
  );

export const ASSISTANT = "msg_0eb735d5b001oAFVeY5jz3WD4Z";

export const rateLimited = {
  type: "provider.rate-limit",
  message: "Rate limit exceeded: free-models-per-min.",
  status: 429,
};
/**
 * OpenCode numbers the request it retries with, so its first retry is
 * attempt 2, and stamps `at` from the clock behind the event's `created` (1 here).
 */

export const retryScheduled = (attempt: number, delayMs: number) =>
  event("session.retry.scheduled", {
    sessionID: SESSION,
    assistantMessageID: ASSISTANT,
    attempt,
    at: 1 + delayMs,
    error: rateLimited,
  });

export const retrying = {
  class: "provider_error",
  message: rateLimited.message,
  code: rateLimited.type,
  retryable: true,
} satisfies OrchestrationV2ProviderFailure;

export const firstRetry = { attempt: 1, maxAttempts: null, retryDelayMs: 2_000 };

export const errorRows = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  collected.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem] : [],
  );

export const runRetryTurn = (entries: ReadonlyArray<ProviderReplayEntry>, gate?: ProviderReplayGate) =>
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

export const continued = (after: ReadonlyArray<ProviderReplayEntry>) =>
  Effect.gen(function* () {
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

export const CONTINUED_PROMPT = `msg_t3_turn_${SESSION}:attempt:attempt:opencode2-adapter`;

export const CONTINUED_REPORT = `<subagent sessionID="${CHILD}" state="completed" description="Sleep">\nCHILD_OK\n</subagent>`;

export const continuedHistory = {
  data: [
    { id: "msg_report", time: { created: 2 }, text: CONTINUED_REPORT, type: "synthetic" },
    { id: CONTINUED_PROMPT, time: { created: 1 }, text: "hi", type: "user" },
  ],
  cursor: {},
};

export const providerTurnId = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  return ids.derive.providerTurn({
    driver: OPENCODE_PROVIDER,
    nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
  });
}).pipe(Effect.provide(IdAllocator.layer));
