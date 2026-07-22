import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess } from "effect/unstable/process";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import {
  buildCodexTurnStartParams,
  CODEX_DEFAULT_INSTANCE_ID,
  CODEX_DRIVER_KIND,
  codexBackgroundCommandDetail,
  codexThreadRuntimeParams,
  type CodexAgentMessageDeltaUpdate,
  type CodexAppServerClientFactoryShape,
  makeCodexAdapterV2,
  makeCodexAgentMessageDeltaCoalescer,
  makeCodexAppServerProtocolLogger,
  makeCodexAppServerSpawnCommand,
  projectCodexDynamicToolItem,
  resolveCodexRollbackTurnCount,
} from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("makes accumulated assistant text visible after the bounded flush interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<
        ReadonlyArray<{
          readonly turnId: string;
          readonly itemId: string;
          readonly text: string;
          readonly completed: boolean;
        }>
      >([]);
      const coalescer = yield* makeCodexAgentMessageDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "partial" });
      assert.deepEqual(yield* Ref.get(updates), []);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "partial",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("coalesces multiple token deltas into one assistant update per interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<CodexAgentMessageDeltaUpdate>>([]);
      const coalescer = yield* makeCodexAgentMessageDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "one" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " two" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " three" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "one two three",
          completed: false,
        },
      ]);
    }),
  );

  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<CodexAgentMessageDeltaUpdate>>([]);
      const coalescer = yield* makeCodexAgentMessageDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "turn final", completed: true },
      ]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 2);
    }),
  );

  it.effect("retains buffered text until completion updates are emitted", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<CodexAgentMessageDeltaUpdate>>([]);
      const failNext = yield* Ref.make(true);
      const coalescer = yield* makeCodexAgentMessageDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Ref.getAndSet(failNext, false).pipe(
            Effect.flatMap((shouldFail) =>
              shouldFail
                ? Effect.die("projection unavailable")
                : Ref.update(updates, (current) => [...current, update]),
            ),
          ),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "turn final" });
      const failedFlush = yield* coalescer.flushTurn("turn-1").pipe(Effect.exit);
      assert.equal(failedFlush._tag, "Failure");
      yield* coalescer.flushTurn("turn-1");

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "item final" });
      yield* Ref.set(failNext, true);
      const failedComplete = yield* coalescer
        .complete({ turnId: "turn-1", itemId: "message-2" })
        .pipe(Effect.exit);
      assert.equal(failedComplete._tag, "Failure");
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-2",
      });

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "turn final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "item final", completed: true },
      ]);
    }),
  );
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect("derives concrete Codex turn policies from every T3 runtime mode", () =>
    Effect.gen(function* () {
      const build = (runtimeMode: "approval-required" | "auto-accept-edits" | "full-access") =>
        buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("preserves explicit Codex turn policy overrides", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-override",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
          },
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      });

      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.sandboxPolicy?.type, "readOnly");
    }),
  );

  it.effect("adds default-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-orchestration-instructions",
        codexInput: [{ type: "text", text: "delegate this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.include(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "use `delegate_task`",
      );
      assert.include(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "structured object, never as JSON text",
      );
    }),
  );

  it.effect("compiles per-turn Codex model options and cwd from their owning inputs", () =>
    Effect.gen(function* () {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: "/workspace/model-options",
          reasoningEffort: "low",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      });

      assert.equal(params.model, "gpt-5.4");
      assert.equal(params.effort, "xhigh");
      assert.equal(params.serviceTier, "priority");
      assert.equal(params.cwd, "/workspace/model-options");
      assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");
    }),
  );
});

describe("CodexAdapterV2 process spawning", () => {
  it("injects cwd, model, and MCP authorization into thread-scoped params", () => {
    const threadId = ThreadId.make("thread-codex-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-codex-mcp"),
      threadId,
      providerSessionId: "mcp-session-codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
    });

    try {
      assert.deepEqual(
        codexThreadRuntimeParams({
          threadId,
          modelSelection: { model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace/thread-codex-mcp",
          },
        }),
        {
          cwd: "/workspace/thread-codex-mcp",
          model: "gpt-5.4",
          config: {
            mcp_servers: {
              "t3-code": {
                url: "http://127.0.0.1:43123/mcp",
                http_headers: {
                  Authorization: "Bearer secret-codex-token",
                },
              },
            },
          },
        },
      );
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it.effect("resolves Windows command shims through the shared spawn policy", () =>
    Effect.gen(function* () {
      const command = yield* makeCodexAppServerSpawnCommand({
        command: "codex",
        args: ["app-server", "argument with spaces"],
        cwd: "C:\\workspace",
        env: { CUSTOM: "1" },
        extendEnv: true,
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, '^"C:\\npm\\codex.cmd^"');
      assert.deepEqual(command.args, ['^"app-server^"', '^"argument^ with^ spaces^"']);
      assert.equal(command.options.shell, true);
      assert.equal(command.options.cwd, "C:\\workspace");
      assert.deepEqual(command.options.env, { CUSTOM: "1" });
      assert.equal(command.options.extendEnv, true);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\Windows\\System32",
        HOST_ONLY: "1",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
        assert.equal(environment.HOST_ONLY, "1");
        assert.equal(environment.CUSTOM, "1");
        return "C:\\npm\\codex.cmd";
      }),
    ),
  );

  it.effect("uses direct execution for native executables", () =>
    Effect.gen(function* () {
      const command = yield* makeCodexAppServerSpawnCommand({
        command: "codex.exe",
        args: ["app-server"],
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, "C:\\bin\\codex.exe");
      assert.deepEqual(command.args, ["app-server"]);
      assert.equal(command.options.shell, false);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
    ),
  );
});

describe("CodexAdapterV2 dynamic tool projection", () => {
  it("preserves MCP arguments and prefers structured output", () => {
    const projection = projectCodexDynamicToolItem({
      type: "mcpToolCall",
      id: "call-create-threads",
      server: "t3-code",
      tool: "create_threads",
      status: "completed",
      arguments: {
        threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
      },
      result: {
        content: [{ type: "text", text: '{"threads":[{"threadId":"thread:mcp:fixture:0"}]}' }],
        structuredContent: {
          threads: [{ threadId: "thread:mcp:fixture:0" }],
        },
      },
    });

    assert.deepEqual(projection, {
      toolName: "t3-code.create_threads",
      input: {
        threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
      },
      output: {
        threads: [{ threadId: "thread:mcp:fixture:0" }],
      },
      status: "completed",
    });
  });

  it("preserves namespaced dynamic tool output", () => {
    const projection = projectCodexDynamicToolItem({
      type: "dynamicToolCall",
      id: "call-dynamic",
      namespace: "workspace",
      tool: "inspect",
      status: "failed",
      arguments: { path: "package.json" },
      contentItems: [{ type: "inputText", text: "inspection failed" }],
      success: false,
    });

    assert.deepEqual(projection, {
      toolName: "workspace.inspect",
      input: { path: "package.json" },
      output: [{ type: "inputText", text: "inspection failed" }],
      status: "failed",
    });
  });
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("writes app-server protocol frames to the native provider log", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/event",
          params: {
            id: "evt-1",
            http_headers: { Authorization: "Bearer secret-codex-token" },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        },
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "thread/event",
            params: {
              id: "evt-1",
              http_headers: { Authorization: "[REDACTED]" },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            },
          },
        },
      });
    }),
  );

  it("does not install a protocol logger when native logging is unavailable", () => {
    const protocolLogger = makeCodexAppServerProtocolLogger({
      nativeEventLogger: undefined,
      threadId: ThreadId.make("thread-1"),
      providerSessionId: ProviderSessionId.make("provider-session-1"),
    });

    assert.equal(protocolLogger, undefined);
  });
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");

      const numTurns = yield* resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});

describe("CodexAdapterV2 background command detail", () => {
  it("summarizes command, exit code, and output tail", () => {
    assert.equal(
      codexBackgroundCommandDetail({
        command: "sleep 20 && echo CODEX_BG_WAKE_DONE",
        exitCode: 0,
        aggregatedOutput: "CODEX_BG_WAKE_DONE\n",
      }),
      "Background command completed (exit 0): sleep 20 && echo CODEX_BG_WAKE_DONE\n\n" +
        "Output tail:\nCODEX_BG_WAKE_DONE",
    );
  });

  it("omits the output section and exit code when absent", () => {
    assert.equal(
      codexBackgroundCommandDetail({
        command: "sleep 20",
        exitCode: null,
        aggregatedOutput: null,
      }),
      "Background command completed: sleep 20",
    );
  });

  it("truncates long commands and keeps only the output tail", () => {
    const detail = codexBackgroundCommandDetail({
      command: "x".repeat(300),
      exitCode: 1,
      aggregatedOutput: `${"y".repeat(2000)}TAIL`,
    });
    assert.include(detail, `(exit 1): ${"x".repeat(200)}...`);
    assert.include(detail, "Output tail:\n...");
    assert.include(detail, "TAIL");
    assert.notInclude(detail, "y".repeat(1001));
  });
});

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed";
}): Record<string, unknown> {
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: input.status === "completed" ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "t3code_desktop/0.144.0",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: { id: 2, method: "thread/start", params: {} },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
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
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

describe("CodexAdapterV2 post-settle continuation", () => {
  const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });

  const makeCodexReplayHarness = (transcript: CodexReplay.CodexAppServerReplayTranscript) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
      const continuationRequests: Array<ProviderContinuationRequest> = [];
      const clientFactory: CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplay(transcript)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterOpenSessionError({
                  driver: CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
            ),
          ),
      };
      const adapter = makeCodexAdapterV2({
        instanceId: CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory,
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapterV2Event> = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      const subagentUpdates = () =>
        events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated",
        );
      return {
        runtime,
        providerThread,
        threadId,
        events,
        continuationRequests,
        terminalEvents,
        subagentUpdates,
        hasPendingBackgroundWork,
      };
    });

  const BG_SCENARIO = "codex-bg-exec-wake";
  const BG_NATIVE_THREAD = "native-codex-bg-thread";
  const BG_NATIVE_TURN = "native-codex-bg-turn";
  const BG_COMMAND_ITEM = "call-codex-bg-command";
  const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";
  const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

  const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: BG_COMMAND_ITEM,
    command: BG_COMMAND,
    cwd: "/workspace",
    processId: "4242",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: BG_COMMAND }],
    aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 25_000 : null,
  });

  const backgroundExecTranscript = makeCodexReplayTranscript({
    scenario: BG_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: BG_NATIVE_THREAD,
        nativeTurnId: BG_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-bg",
              text: "STARTED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: BG_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect(
    "projects a post-settle background command completion and requests a continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(backgroundExecTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-wake"),
              text: BG_PROMPT,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.continuationRequests, 0);
          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");

          yield* TestClock.adjust("30 seconds");
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation request",
          );
          const request = harness.continuationRequests[0];
          assert.equal(request?.threadId, harness.threadId);
          assert.equal(request?.providerThreadId, harness.providerThread.id);
          assert.equal(request?.driver, CODEX_DRIVER_KIND);
          assert.equal(
            request?.detail,
            `Background command completed (exit 0): ${BG_COMMAND}\n\n` +
              "Output tail:\nCODEX_BG_WAKE_DONE",
          );

          const lateCommandUpdateIndex = () =>
            harness.events.findIndex(
              (event, index) =>
                index > terminalIndex &&
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.output === "CODEX_BG_WAKE_DONE\n" &&
                event.turnItem.exitCode === 0,
            );
          yield* awaitUntil(
            () => lateCommandUpdateIndex() > terminalIndex,
            "post-settle command projection",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";
  const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";
  const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

  const preSettleTranscript = makeCodexReplayTranscript({
    scenario: PRE_SETTLE_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
        nativeTurnId: PRE_SETTLE_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-pre-settle",
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-pre-settle",
              text: "DONE",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
          },
        },
      },
    ],
  });

  it.effect("does not request a continuation for a command that completes before settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(preSettleTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-bg-pre-settle"),
            text: BG_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.exitCode === 0,
            ),
          "pre-settle command projection",
        );

        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const RESUME_SCENARIO = "codex-resume-subagent";
  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          phase: "final_answer",
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
      },
    },
  });

  const childTurnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: RESUME_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect("re-opens a resumed subagent and hydrates its post-settle result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-resume"),
            text: RESUME_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const settledUpdates = harness.subagentUpdates();
        const firstCompletion = settledUpdates[settledUpdates.length - 1];
        assert.equal(firstCompletion?.subagent.status, "completed");
        assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        const settledUpdateCount = settledUpdates.length;

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(
          () => harness.subagentUpdates().length > settledUpdateCount,
          "subagent re-open",
        );
        const reopened = harness.subagentUpdates()[settledUpdateCount];
        assert.equal(reopened?.subagent.status, "running");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(() => {
          const updates = harness.subagentUpdates();
          const latest = updates[updates.length - 1];
          return (
            latest !== undefined &&
            latest.subagent.status === "completed" &&
            latest.subagent.result === "CODEX_RESUME_DONE"
          );
        }, "resumed subagent completion");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );
});
