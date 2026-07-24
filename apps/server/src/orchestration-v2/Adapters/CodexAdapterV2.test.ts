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
import * as Fiber from "effect/Fiber";
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

  it.effect("can discard an empty completion without emitting an assistant update", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<CodexAgentMessageDeltaUpdate>>([]);
      const coalescer = yield* makeCodexAgentMessageDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
        emitEmpty: false,
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), []);

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "buffered" });
      assert.equal(
        yield* coalescer.complete({
          turnId: "turn-1",
          itemId: "message-2",
          emitEmpty: false,
        }),
        "buffered",
      );
      assert.deepEqual(yield* Ref.get(updates), [
        {
          turnId: "turn-1",
          itemId: "message-2",
          text: "buffered",
          completed: true,
        },
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
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
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

  const assistantMessages = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
    events.filter(
      (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.role === "assistant",
    );

  const finalAnswerTranscript = (
    scenario: string,
    answers: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly phase?: "commentary" | "final_answer" | null;
      readonly omitPhase?: boolean;
      readonly streamed?: boolean;
      readonly completionDelayMs?: number;
    }>,
  ) => {
    const nativeThreadId = `native-${scenario}-thread`;
    const nativeTurnId = `native-${scenario}-turn`;
    const prompt = "Reply with the requested recovery marker.";
    return makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
              frame: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: answer.text,
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000 + index,
                },
              },
            };
            if (!answer.streamed) {
              return [completed];
            }
            return [
              {
                type: "emit_inbound",
                label: `item/started/${answer.id}`,
                frame: {
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: "",
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    startedAtMs: 1782622440500 + index,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: `item/agentMessage/delta/${answer.id}`,
                frame: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: answer.id,
                    delta: answer.text,
                  },
                },
              },
              completed,
            ];
          },
        ),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        },
      ],
    });
  };

  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("suppresses a later streamed duplicate final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-streamed-duplicate-final", [
          { id: "answer-original", text: "CODEX_RECOVERY_OK" },
          {
            id: "answer-duplicate",
            text: "CODEX_RECOVERY_OK",
            streamed: true,
            completionDelayMs: 100,
          },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-streamed-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => assistantMessages(harness.events).length === 1, "original answer");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("buffers an overlapping later final stream until duplicate detection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-overlapping-duplicate-final";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const answerItem = (id: string, text: string) => ({
          type: "agentMessage" as const,
          id,
          text,
          phase: "final_answer" as const,
          memoryCitation: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Reply with the requested recovery marker.",
            }),
            ...["answer-overlap-original", "answer-overlap-duplicate"].flatMap(
              (itemId, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
                {
                  type: "emit_inbound",
                  label: `item/started/${itemId}`,
                  frame: {
                    method: "item/started",
                    params: {
                      item: answerItem(itemId, ""),
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622440500 + index,
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  label: `item/agentMessage/delta/${itemId}`,
                  frame: {
                    method: "item/agentMessage/delta",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      itemId,
                      delta: "CODEX_RECOVERY_OK",
                    },
                  },
                },
              ],
            ),
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-original",
              afterMs: 100,
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-original", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-duplicate",
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-duplicate", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441001,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-overlapping-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.equal(
          new Set(assistantMessages(harness.events).map((event) => event.message.id)).size,
          1,
        );

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(
          new Set(assistantMessages(harness.events).map((event) => event.message.id)).size,
          1,
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("preserves a sole empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-sole-empty-final", [
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-sole-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("suppresses a second empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-duplicate-empty-final", [
          { id: "answer-empty-original", text: "" },
          { id: "answer-empty-duplicate", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-duplicate-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("preserves an empty final answer when only commentary preceded it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-commentary-then-empty-final", [
          { id: "answer-commentary", text: "Working on it.", phase: "commentary" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-commentary-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["Working on it.", ""],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("suppresses an empty final answer after a non-empty unknown-phase answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-unknown-non-empty-then-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK", phase: null },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-unknown-non-empty-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("suppresses a trailing empty answer with an omitted phase", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-final-then-empty-unknown", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "", omitPhase: true },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-final-then-empty-unknown"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("keeps a later non-empty final answer after an initial empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-empty-then-non-empty-final", [
          { id: "answer-empty", text: "" },
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-empty-then-non-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["", "CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

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

  const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";
  const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";
  const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";
  const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";
  const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";
  const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";
  const INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-child-timeout-boundary";
  const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";
  const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";
  const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";
  const INTERRUPT_LATE_CHILD_2_NATIVE_TURN = "native-codex-interrupt-late-child-2-turn";
  const INTERRUPT_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-timeout-boundary";
  const INTERRUPT_TIMEOUT_LATE_ITEM = "exec-codex-interrupt-timeout-late";
  const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";
  const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";
  const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

  const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: INTERRUPT_COMMAND_ITEM,
    command: INTERRUPT_COMMAND,
    cwd: "/workspace",
    processId: "57680",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
    aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 30_000 : null,
  });

  const interruptMidCommandTranscript = makeCodexReplayTranscript({
    scenario: INTERRUPT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: { id: 6, result: { data: [], nextCursor: null } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 7,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 7, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect("contains commands that start before and after the interrupt response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-mid-command"),
            text: INTERRUPT_PROMPT,
          }),
        );

        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );

        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(terminalIndex, 0);

        let lastCommandBeforeTerminal:
          | Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>
          | undefined;
        for (let index = 0; index < terminalIndex; index++) {
          const event = harness.events[index];
          if (event?.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            lastCommandBeforeTerminal = event;
          }
        }
        assert.isDefined(lastCommandBeforeTerminal);
        assert.equal(lastCommandBeforeTerminal.turnItem.status, "interrupted");
        assert.isNotNull(lastCommandBeforeTerminal.turnItem.completedAt);

        const interruptedCommandsBeforeTerminal = harness.events
          .slice(0, terminalIndex)
          .flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? [event.turnItem.input]
              : [],
          )
          .sort();
        assert.deepEqual(
          interruptedCommandsBeforeTerminal,
          [INTERRUPT_COMMAND, INTERRUPT_COMMAND_TWO].sort(),
        );

        const interruptedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted",
        );
        assert.isAbove(
          terminalIndex,
          interruptedCommandIndex,
          "command terminalization must precede turn.terminal",
        );

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        // Late provider item/completed after interrupt must not revive the card
        // or request a background-command wake continuation.
        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);

        const postTerminalCommandUpdates = harness.events.filter(
          (event, index) =>
            index > terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution",
        );
        assert.lengthOf(
          postTerminalCommandUpdates,
          0,
          "late item/completed after interrupt must not project",
        );

        const commandUpdates = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isAtLeast(commandUpdates.length, 2, "start + interrupt terminalization");
        assert.equal(commandUpdates[commandUpdates.length - 1]?.turnItem.status, "interrupted");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-command",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-interrupt-subagent",
              kind: "started",
              agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
              agentPath: "/root/stop_hold",
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/child-command",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_COMMAND_ITEM,
              processId: "57682",
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/root",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/root",
        frame: { id: 4, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: { id: 5, result: {} },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/child-completed-race",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const assertChildProviderTerminalBeforeRoot = (
    events: ReadonlyArray<ProviderAdapterV2Event>,
    rootThreadId: ThreadId,
  ) => {
    const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
    const childProviderTurnIndex = events.findIndex(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.threadId !== rootThreadId &&
        event.providerTurn.status === "interrupted",
    );
    const childProviderThreadIndex = events.findIndex(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.appThreadId !== rootThreadId &&
        event.providerThread.status === "idle",
    );
    assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
    assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
    assert.isAbove(
      terminalIndex,
      childProviderTurnIndex,
      "child provider turn must terminalize before the root run",
    );
    assert.isAbove(
      terminalIndex,
      childProviderThreadIndex,
      "child provider thread must become idle before the root run",
    );
  };

  it.effect("contains descendant commands and keeps Stop authoritative", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-command"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const childCommandUpdates = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM,
        );
        assert.equal(childCommandUpdates.at(-1)?.turnItem.status, "interrupted");
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const childInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/child",
  );
  const rootInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/root",
  );
  const interruptSubagentRequestFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-request-failure",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootInterruptResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-before-child-interrupt-failure",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(
        rootInterruptResponseIndex + 1,
        childInterruptResponseIndex,
      ),
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          error: { code: -32_000, message: "child interrupt request failed" },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("terminalizes descendants before the root when an interrupt request fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentRequestFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-request-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const childTerminationResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "thread/backgroundTerminals/terminate/child",
  );
  const interruptSubagentTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-timeout",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "item/started/child-timeout-boundary",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM,
              processId: null,
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441600,
          },
        },
      },
    ],
  });

  it.effect("terminalizes timed-out descendants before the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM &&
                event.turnItem.status === "running",
            ),
          "child timeout boundary item",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
  );
  const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
      {
        type: "emit_inbound",
        label: "turn/started/late-child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child",
        frame: { id: 7, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants that start after the initial Stop snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child provider turn",
        );
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        const lateChildUpdates = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
        );
        assert.equal(lateChildUpdates.at(-1)?.providerTurn.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const interruptRescanLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-rescan-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/started/late-child-1",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-1",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/late-child-2",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-1",
        frame: { id: 7, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-2",
        frame: {
          id: 8,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-2",
        frame: { id: 8, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants discovered only by the final interrupt rescan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptRescanLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-rescan-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child 1 provider turn",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const rootTerminalIndex = harness.events.findIndex(
          (event) => event.type === "turn.terminal",
        );
        const lateChild1InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        const lateChild2InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_2_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        assert.isAtLeast(
          lateChild1InterruptedIndex,
          0,
          "late child 1 must terminalize interrupted",
        );
        assert.isAtLeast(
          lateChild2InterruptedIndex,
          0,
          "late child 2 must terminalize interrupted",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild1InterruptedIndex,
          "late child 1 must terminalize before the root run",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild2InterruptedIndex,
          "late child 2 must terminalize before the root run",
        );
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const interruptTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-timeout",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-at-timeout-boundary",
        afterMs: 9_999,
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
              command: "echo TIMEOUT_BOUNDARY",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo TIMEOUT_BOUNDARY" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622450500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/late",
        afterMs: 20_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-after-timeout",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_LATE_ITEM,
              command: "echo LATE_AFTER_TIMEOUT",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo LATE_AFTER_TIMEOUT" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622470500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("bounds interrupt settlement and drops late completion events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 1,
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 2,
          "post-interrupt running command item",
        );

        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "timeout terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const terminalProviderTurnsBeforeLateEvents = harness.events.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
        );
        assert.lengthOf(terminalProviderTurnsBeforeLateEvents, 1);

        const commandUpdatesBeforeLateEvents = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        const terminalCommands = commandUpdatesBeforeLateEvents.filter(
          (event) =>
            event.turnItem.status === "interrupted" &&
            event.turnItem.nativeItemRef?.nativeId !== INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        assert.lengthOf(terminalCommands, 2);
        const boundaryUpdates = commandUpdatesBeforeLateEvents.filter(
          (event) => event.turnItem.nativeItemRef?.nativeId === INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        const lastBoundaryUpdate = boundaryUpdates.at(-1);
        assert.isDefined(lastBoundaryUpdate);
        assert.equal(lastBoundaryUpdate.turnItem.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("20 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
          ),
          terminalProviderTurnsBeforeLateEvents.length,
          "late completion must not duplicate provider-turn finalization",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          commandUpdatesBeforeLateEvents.length,
          "late starts and completions must not project after timeout",
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-termination-failure",
    entries: [
      ...interruptMidCommandTranscript.entries
        .filter(
          (entry) => entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
        )
        .map((entry) =>
          entry.type === "emit_inbound" &&
          entry.label === "thread/backgroundTerminals/list/after-false"
            ? {
                ...entry,
                frame: {
                  id: 6,
                  result: {
                    data: [{ processId: "57680" }],
                    nextCursor: null,
                  },
                },
              }
            : entry,
        ),
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: {
          id: 8,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: { id: 8, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          result: { data: [{ processId: "57680" }], nextCursor: null },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("attempts every terminal and cleans up tracking when termination fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTerminationFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-termination-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const FAILED_SCENARIO = "codex-failed-mid-command";
  const FAILED_NATIVE_THREAD = "native-codex-failed-thread";
  const FAILED_NATIVE_TURN = "native-codex-failed-turn";
  const FAILED_COMMAND_ITEM = "exec-codex-failed-command";
  const FAILED_COMMAND = "sleep 30";
  const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

  const failedMidCommandTranscript = makeCodexReplayTranscript({
    scenario: FAILED_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: FAILED_NATIVE_THREAD,
        nativeTurnId: FAILED_NATIVE_TURN,
        prompt: FAILED_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: FAILED_COMMAND_ITEM,
              command: FAILED_COMMAND,
              cwd: "/workspace",
              processId: "99",
              source: "unifiedExecStartup",
              status: "inProgress",
              commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            threadId: FAILED_NATIVE_THREAD,
            turnId: FAILED_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: FAILED_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({
                id: FAILED_NATIVE_TURN,
                status: "failed",
              }),
              error: { message: "provider failed mid-command" },
            },
          },
        },
      },
    ],
  });

  it.effect("terminalizes running command items before turn.terminal on failed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-failed-mid-command"),
            text: FAILED_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const failedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "failed",
        );
        assert.isAtLeast(failedCommandIndex, 0);
        assert.isAbove(
          terminalIndex,
          failedCommandIndex,
          "failed-turn command terminalization must precede turn.terminal",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
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
    readonly omitPhase?: boolean;
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
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
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

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
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
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
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

  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
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
        yield* awaitUntil(
          () =>
            harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          "first subagent result",
        );
        assert.lengthOf(
          harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          1,
        );
        yield* TestClock.adjust("100 millis");
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
