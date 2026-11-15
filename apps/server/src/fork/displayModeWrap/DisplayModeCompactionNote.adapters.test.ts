import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { MESSAGES_ONLY_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProviderInstallationGate from "../../provider/ProviderInstallationGate.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as ServerSettings from "../../serverSettings.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const turnInput = (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly modelSelection: ModelSelection;
  readonly now: DateTime.Utc;
  readonly text: string;
  readonly commandNote?: ProviderAdapter.ProviderAdapterV2TurnInput["commandNote"];
}): ProviderAdapter.ProviderAdapterV2TurnInput => {
  const attemptId = RunAttemptId.make(`attempt-${input.threadId}`);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project-${input.threadId}`),
      title: "Compaction note",
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run-${input.threadId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make(`node-${input.threadId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.threadId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimePolicy,
    ...(input.commandNote === undefined ? {} : { commandNote: input.commandNote }),
  };
};

const settingsFor = (threadId: ThreadId) =>
  ServerSettings.layerTest({ threadDisplayModes: { [threadId]: "messages-only" } });

/** The production layer that gives the adapters their services, so a test fails if it drops the note. */
const infrastructureFor = (threadId: ThreadId, prefix: string) =>
  ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provide(Layer.merge(PortScanner.layerTest, SqlitePersistence.layerMemory)),
    Layer.provideMerge(settingsFor(threadId)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ProviderInstallationGate.layer),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const commandNoteText = "<t3-display-mode>Note for the command.</t3-display-mode>";

const claudeModelSelection = {
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

/** Starts a Claude turn on an adapter built on the provider infrastructure, and returns the query options. */
const startClaudeTurn = Effect.fn("startClaudeTurn")(function* (
  threadId: ThreadId,
  turn: {
    readonly text: string;
    readonly commandNote?: ProviderAdapter.ProviderAdapterV2TurnInput["commandNote"];
  },
) {
  const modelSelection = claudeModelSelection;
  const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: decodeClaudeSettings({}),
    },
    {},
  ).pipe(
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-compaction-note"),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      subagentModel: () => Effect.succeed(null),
      assertComplete: Effect.void,
    }),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-compaction-note-claude"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  yield* runtime.startTurn(
    turnInput({ threadId, providerThread, modelSelection, now: yield* DateTime.now, ...turn }),
  );
  const options = opened[0];
  assert.isDefined(options);
  return options!;
});

it.effect("a Claude adapter built on the provider infrastructure adds the thread's note", () => {
  const threadId = ThreadId.make("thread:compaction-note:claude-infrastructure");
  return Effect.gen(function* () {
    const options = yield* startClaudeTurn(threadId, { text: "hi" });
    const callback = options.hooks?.SessionStart?.[0]?.hooks[0];
    assert.isDefined(callback);
    const input = {
      hook_event_name: "SessionStart",
      source: "compact",
      session_id: "native-thread-compaction-note",
      transcript_path: "/transcripts/native-thread-compaction-note.jsonl",
      cwd: "/workspace",
    } satisfies HookInput;
    assert.deepEqual(
      yield* Effect.promise(() =>
        callback!(input, undefined, { signal: new AbortController().signal }),
      ),
      {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: MESSAGES_ONLY_DISPLAY_MODE.stateNotice,
        },
      },
    );
  }).pipe(Effect.scoped, Effect.provide(infrastructureFor(threadId, "t3-compaction-note-claude-")));
});

it.effect(
  "Claude gets upstream's send_to_user section from the hook in Normal, not in its system prompt",
  () => {
    const normalId = ThreadId.make("thread:send-section:normal");
    const messagesOnlyId = ThreadId.make("thread:send-section:messages-only");
    const section = "### Text the user must read mid-turn";
    return Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const submitted = Effect.fn("submitted")(function* (threadId: ThreadId) {
        yield* sessions.set({
          environmentId: EnvironmentId.make("environment-send-section"),
          threadId,
          providerSessionId: "mcp-session-send-section",
          providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer send-section",
          browserToolsAvailable: false,
        });
        const options = yield* startClaudeTurn(threadId, { text: "hi" });
        const append = (options.systemPrompt as { readonly append?: string }).append ?? "";
        assert.include(append, "call `t3_background_wait`");
        assert.notInclude(append, section);
        const callback = options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
        const output = yield* Effect.promise(() =>
          callback!(
            {
              hook_event_name: "UserPromptSubmit",
              prompt: "hi",
              session_id: "native-thread-compaction-note",
              transcript_path: "/transcripts/native-thread-compaction-note.jsonl",
              cwd: "/workspace",
            } satisfies HookInput,
            undefined,
            { signal: new AbortController().signal },
          ),
        );
        return "hookSpecificOutput" in output &&
          output.hookSpecificOutput?.hookEventName === "UserPromptSubmit"
          ? output.hookSpecificOutput.additionalContext
          : undefined;
      });
      assert.include(yield* submitted(normalId), section);
      assert.isUndefined(yield* submitted(messagesOnlyId));
    }).pipe(Effect.scoped, Effect.provide(infrastructureFor(messagesOnlyId, "t3-send-section-")));
  },
);

it.effect("Claude gets a slash command's note only with that command's own prompt", () => {
  const threadId = ThreadId.make("thread:command-note:claude");
  return Effect.gen(function* () {
    const deliveries = yield* Ref.make(0);
    const options = yield* startClaudeTurn(threadId, {
      text: "/review",
      commandNote: { text: commandNoteText, delivered: Ref.update(deliveries, (n) => n + 1) },
    });
    assert.strictEqual(yield* Ref.get(deliveries), 0, "an accepted turn is not a delivery");
    const callback = options.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    assert.isDefined(callback);
    const submit = (prompt: string, source?: "system") =>
      Effect.promise(() =>
        callback!(
          {
            hook_event_name: "UserPromptSubmit",
            prompt,
            ...(source === undefined ? {} : { source }),
            session_id: "native-thread-compaction-note",
            transcript_path: "/transcripts/native-thread-compaction-note.jsonl",
            cwd: "/workspace",
          } satisfies HookInput,
          undefined,
          { signal: new AbortController().signal },
        ),
      );

    assert.deepEqual(yield* submit("/compact"), {});
    assert.deepEqual(yield* submit("/review", "system"), {});
    assert.strictEqual(yield* Ref.get(deliveries), 0);
    assert.deepEqual(yield* submit("/review"), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: commandNoteText },
    });
    assert.strictEqual(yield* Ref.get(deliveries), 1);
  }).pipe(Effect.scoped, Effect.provide(infrastructureFor(threadId, "t3-command-note-claude-")));
});

const codexTurn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});

const codexModelSelection = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;

const codexRequest = (id: number, method: string, params: unknown, result: unknown) =>
  [
    { type: "expect_outbound", label: method, frame: { id, method, params } },
    { type: "emit_inbound", label: method, frame: { id, result } },
  ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;

const codexNotification = (method: string, params: unknown) =>
  ({
    type: "emit_inbound",
    frame: { method, params },
  }) satisfies CodexReplay.CodexAppServerReplayEntry;

const codexTurnStart = (input: {
  readonly id: number;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly text: string;
  readonly additionalContext?: Record<string, unknown>;
}) => [
  ...codexRequest(
    input.id,
    "config/read",
    { cwd: "/workspace", includeLayers: false },
    {
      config: {},
      origins: {},
    },
  ),
  {
    type: "expect_outbound" as const,
    label: "turn/start",
    frame: {
      id: input.id + 1,
      method: "turn/start",
      params: {
        threadId: input.nativeThreadId,
        input: [{ type: "text", text: input.text }],
        ...(input.additionalContext === undefined
          ? {}
          : { additionalContext: input.additionalContext }),
        cwd: "/workspace",
        model: "gpt-5.4",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        summary: "auto",
        collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: { id: input.id + 1, result: { turn: codexTurn(input.nativeTurnId, "inProgress") } },
  },
  codexNotification("turn/started", {
    threadId: input.nativeThreadId,
    turn: codexTurn(input.nativeTurnId, "inProgress"),
  }),
];

/** Codex's compaction, the turn's end, then the note that T3 adds again after it, and nothing else. */
const codexCompaction = (input: {
  readonly id: number;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly turnEnd: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}) => [
  codexNotification("item/completed", {
    threadId: input.nativeThreadId,
    turnId: input.nativeTurnId,
    item: { type: "contextCompaction", id: "compaction-note-item" },
  }),
  ...input.turnEnd,
  ...codexRequest(
    input.id,
    "thread/inject_items",
    {
      threadId: input.nativeThreadId,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: MESSAGES_ONLY_DISPLAY_MODE.stateNotice }],
        },
      ],
    },
    {},
  ),
];

/** The frames until Codex has started the thread, which take request ids 1 and 2. */
const codexTranscript = (
  nativeThreadId: string,
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.144.0",
  scenario: nativeThreadId,
  entries: [
    {
      type: "expect_outbound",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      },
    },
    { type: "expect_outbound", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      frame: {
        id: 2,
        result: {
          thread: {
            id: nativeThreadId,
            sessionId: nativeThreadId,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    ...entries,
  ],
});

/**
 * Runs one turn of `text` on a Codex adapter built on the provider infrastructure, against `transcript`,
 * and returns how many times the turn's command note was delivered.
 */
const runCodexTurn = (input: {
  readonly threadId: ThreadId;
  readonly transcript: CodexReplay.CodexAppServerReplayTranscript;
  readonly text: string;
  readonly commandNote?: boolean;
  readonly waitForTerminal: boolean;
}) =>
  Effect.gen(function* () {
    const { threadId, transcript } = input;
    const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: decodeCodexSettings({}),
    }).pipe(
      Effect.provideService(CodexAdapterV2.CodexAppServerClientFactory, {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
          ),
      }),
    );
    const modelSelection = codexModelSelection;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const terminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        event.type === "turn.terminal" ? Deferred.succeed(terminal, undefined) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const deliveries = yield* Ref.make(0);
    yield* runtime.startTurn(
      turnInput({
        threadId,
        providerThread,
        modelSelection,
        now: yield* DateTime.now,
        text: input.text,
        ...(input.commandNote === true
          ? {
              commandNote: {
                text: commandNoteText,
                delivered: Ref.update(deliveries, (n) => n + 1),
              },
            }
          : {}),
      }),
    );
    if (input.waitForTerminal) yield* Deferred.await(terminal).pipe(Effect.timeout("10 seconds"));
    return yield* Ref.get(deliveries);
  }).pipe(
    Effect.scoped,
    Effect.provide(infrastructureFor(input.threadId, `t3-${input.transcript.scenario}-`)),
  );

it.live(
  "a Codex adapter built on the provider infrastructure re-adds the note after a compaction",
  () => {
    const nativeThreadId = "compaction-note-thread";
    const nativeTurnId = "compaction-note-turn";
    return runCodexTurn({
      threadId: ThreadId.make("thread:compaction-note:codex"),
      text: "work",
      waitForTerminal: true,
      transcript: codexTranscript(nativeThreadId, [
        ...codexTurnStart({ id: 3, nativeThreadId, nativeTurnId, text: "work" }),
        ...codexCompaction({
          id: 5,
          nativeThreadId,
          nativeTurnId,
          turnEnd: [
            codexNotification("turn/completed", {
              threadId: nativeThreadId,
              turn: codexTurn(nativeTurnId, "completed"),
            }),
          ],
        }),
      ]),
    });
  },
);

const codexGoal = (nativeThreadId: string, status: string) => ({
  threadId: nativeThreadId,
  objective: "ship it",
  status,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 3,
  createdAt: 1782622440,
  updatedAt: 1782622450,
});

it.live(
  "Codex gets a /goal's note in that turn/start only, and keeps it out of later context",
  () =>
    Effect.gen(function* () {
      const nativeThreadId = "command-note-goal-thread";
      const nativeTurnId = "command-note-goal-turn";
      const threadId = ThreadId.make("thread:command-note:codex-goal");
      const deliveries = yield* runCodexTurn({
        threadId,
        text: "/goal ship it",
        commandNote: true,
        waitForTerminal: true,
        transcript: codexTranscript(nativeThreadId, [
          ...codexRequest(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
          ...codexRequest(
            4,
            "thread/goal/set",
            { threadId: nativeThreadId, objective: "ship it", status: "paused" },
            { goal: codexGoal(nativeThreadId, "paused") },
          ),
          ...codexTurnStart({
            id: 5,
            nativeThreadId,
            nativeTurnId,
            text: "This thread's goal is already set. Do not call create_goal. Start working on it now: ship it",
            additionalContext: {
              "t3_display_mode_message-thread_command-note_codex-goal": {
                kind: "application",
                value: commandNoteText,
              },
            },
          }),
          ...codexRequest(
            7,
            "thread/goal/set",
            { threadId: nativeThreadId, status: "active" },
            { goal: codexGoal(nativeThreadId, "active") },
          ),
          ...codexCompaction({
            id: 8,
            nativeThreadId,
            nativeTurnId,
            turnEnd: [
              codexNotification("thread/goal/updated", {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                goal: codexGoal(nativeThreadId, "complete"),
              }),
              codexNotification("turn/completed", {
                threadId: nativeThreadId,
                turn: codexTurn(nativeTurnId, "completed"),
              }),
            ],
          }),
        ]),
      });
      assert.strictEqual(deliveries, 1);
    }),
);

it.live("Codex leaves a /goal's note owed when the command starts no turn", () =>
  Effect.gen(function* () {
    const nativeThreadId = "command-note-goal-show-thread";
    const deliveries = yield* runCodexTurn({
      threadId: ThreadId.make("thread:command-note:codex-goal-show"),
      text: "/goal",
      commandNote: true,
      waitForTerminal: false,
      transcript: codexTranscript(nativeThreadId, [
        ...codexRequest(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
      ]),
    });
    assert.strictEqual(deliveries, 0);
  }),
);
