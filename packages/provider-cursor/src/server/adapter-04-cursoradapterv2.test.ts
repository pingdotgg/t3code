import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { loadCursorSdk } from "./sdk.ts";

const { ConfigurationError } = loadCursorSdk();

describe("CursorAdapterV2", () => {
  it.effect("projects subagent directory trees Cursor serialized without empty lists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-task-ls-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-task-ls-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      // The SDK serializes subagent steps with protobuf toJson(), which omits empty repeated fields.
      const conversationSteps = [
        {
          toolCall: {
            toolCallId: "tool:ls",
            lsToolCall: {
              args: { path: workspace },
              result: {
                success: {
                  directoryTreeRoot: {
                    absPath: workspace,
                    childrenWereProcessed: true,
                    childrenDirs: [
                      {
                        absPath: path.join(workspace, "src"),
                        childrenFiles: [{ name: "index.ts" }],
                        childrenWereProcessed: true,
                        numFiles: 1,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        {
          toolCall: {
            toolCallId: "tool:lints",
            readLintsToolCall: { args: {}, result: { success: {} } },
          },
        },
        {
          toolCall: {
            toolCallId: "tool:lints-clean-file",
            readLintsToolCall: {
              args: {},
              result: { success: { fileDiagnostics: [{ path: "src/clean.ts" }] } },
            },
          },
        },
        {
          toolCall: {
            toolCallId: "tool:mcp",
            mcpToolCall: {
              args: { providerIdentifier: "docs", toolName: "lookup", args: { query: "ls" } },
              result: { success: {} },
            },
          },
        },
      ];
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-task-ls",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  const args = {
                    description: "Explore",
                    prompt: "List the workspace.",
                    subagentType: { kind: "unspecified" as const },
                    agentId: "cursor-task-agent",
                    mode: "unspecified" as const,
                  };
                  yield* input.onDelta!({
                    type: "tool-call-started",
                    modelCallId: "model-call",
                    callId: "task-call",
                    toolCall: { type: "task", args },
                  });
                  yield* input.onDelta!({
                    type: "tool-call-completed",
                    modelCallId: "model-call",
                    callId: "task-call",
                    toolCall: {
                      type: "task",
                      args,
                      result: {
                        status: "success",
                        value: {
                          conversationSteps,
                          isBackground: false,
                          backgroundReason: "unspecified",
                        },
                      },
                    },
                  });
                  return {
                    agentId: "native-cursor-task-ls",
                    runId: "native-cursor-run",
                    wait: Effect.succeed({
                      id: "native-cursor-run",
                      requestId: "native-request",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }).pipe(Effect.orDie),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-task-ls-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-task-ls-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-task-ls-attempt"),
        rootNodeId: NodeId.make("cursor-task-ls-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-task-ls-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor subagent ls",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-task-ls-message"),
          createdBy: "user",
          creationSource: "web",
          text: "List the workspace with a subagent.",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "completed");
      const childThreadId = events.findLast((event) => event.type === "subagent.updated")?.subagent
        .childThreadId;
      assert.isDefined(childThreadId);
      assert.deepEqual(
        events.flatMap((event): ReadonlyArray<unknown> => {
          if (event.type !== "turn_item.updated" || event.turnItem.threadId !== childThreadId) {
            return [];
          }
          const item = event.turnItem;
          return item.type === "file_search"
            ? [{ status: item.status, pattern: item.pattern, results: item.results ?? [] }]
            : item.type === "dynamic_tool"
              ? [{ status: item.status, toolName: item.toolName, output: item.output }]
              : [];
        }),
        [
          {
            status: "completed",
            pattern: workspace,
            results: [{ fileName: path.join(workspace, "src", "index.ts") }],
          },
          { status: "completed", pattern: "", results: [] },
          { status: "completed", pattern: "", results: [] },
          {
            status: "completed",
            toolName: "mcp__docs__lookup",
            output: { content: [], isError: false },
          },
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
  it.effect("names a custom model Cursor's account catalog rejects", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-model-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-custom-model-thread");
      const catalogModel = { instanceId, model: "composer-2.5" };
      const customModel = { instanceId, model: "deepseek/deepseek-v4.1-flash" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      // The SDK checks every create, resume, and send model against the account catalog.
      const checkModel = (method: string, model: { readonly id: string } | undefined) =>
        model === undefined || model.id === "composer-2.5"
          ? Effect.void
          : Effect.fail(
              new CursorAgentSdk.CursorAgentSdkRunnerError({
                method,
                cause: new ConfigurationError(
                  `Cannot use this model: ${model.id}. Available models: default, composer-2.5. Use Cursor.models.list() to discover valid selections.`,
                  { isRetryable: false },
                ),
              }),
            );
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (input) =>
            checkModel(`agent.${input.operation}`, input.options.model).pipe(
              Effect.as({
                agentId: "native-cursor-custom-model",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (sendInput) =>
                  checkModel("run.start", sendInput.options?.model).pipe(
                    Effect.andThen(Effect.die("unexpected Cursor run")),
                  ),
              }),
            ),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-custom-model-session"),
        modelSelection: catalogModel,
        runtimePolicy,
      });
      const expected =
        'Cursor cannot run the model "deepseek/deepseek-v4.1-flash". Cursor only runs models from your Cursor account. Choose one of those, or use OpenCode for OpenRouter and other API-key models.';

      const createFailure = yield* runtime
        .ensureThread({ threadId, modelSelection: customModel, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(makeProviderFailure({ cause: createFailure }).message, expected);

      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: catalogModel,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const sendFailure = yield* runtime
        .startTurn({
          threadId,
          providerThread,
          modelSelection: customModel,
          runtimePolicy,
          runId: RunId.make("cursor-custom-model-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-custom-model-attempt"),
          rootNodeId: NodeId.make("cursor-custom-model-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-custom-model-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor custom model",
            providerInstanceId: instanceId,
            modelSelection: customModel,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make("cursor-custom-model-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Hello.",
            attachments: [],
          },
        })
        .pipe(Effect.flip);
      assert.equal(makeProviderFailure({ cause: sendFailure }).message, expected);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          approvalPolicy: "never",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    // Auto-review can gate Windows execution without the unsupported SDK sandbox.
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          sandboxPolicy: { type: "workspaceWrite" },
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
  });
  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(cursorMcpServers(mcpSession), {
      "t3-code": {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: {
          Authorization: "Bearer secret-cursor-mcp-token",
        },
      },
    });

    const options = makeCursorAgentOptions({
      apiKey: "secret-cursor-api-key",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2.5",
      },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
      threadId,
      mcpSession,
      platform: "linux",
    });
    assert.deepEqual(options.mcpServers, cursorMcpServers(mcpSession));

    const logged = JSON.stringify(CursorAgentSdk.loggedCursorAgentOptions(options));
    assert.notInclude(logged, "secret-cursor-api-key");
    assert.notInclude(logged, "secret-cursor-mcp-token");
  });
  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(CursorAgentSdk.isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      CursorAgentSdk.isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(CursorAgentSdk.isCursorCancellationError(new Error("request failed")));
    assert.isFalse(CursorAgentSdk.isCursorCancellationError(null));
  });
  it("preserves failed nested read calls when Cursor omits their path", () => {
    assert.deepEqual(
      nestedToolCallFromEnvelope({
        toolCallId: "tool:failed-read",
        readToolCall: {
          args: {},
          result: { error: "File path was not provided." },
        },
      }),
      {
        callId: "tool:failed-read",
        toolCall: {
          type: "read",
          args: { path: "<unknown path>" },
          result: {
            status: "error",
            error: "File path was not provided.",
          },
        },
      },
    );
  });
});
