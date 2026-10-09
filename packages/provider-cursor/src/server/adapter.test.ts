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
import { CursorSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  it.effect.each([
    { status: "finished", model: undefined, lateModel: undefined },
    { status: "cancelled", model: "claude-opus-4-6", lateModel: undefined },
    { status: "error", model: "custom-fable", lateModel: undefined },
    { status: "finished", model: undefined, lateModel: "gpt-6-sol" },
    { status: "finished", model: "gpt-6-sol", lateModel: null },
  ] as const)(
    "projects Cursor tasks: $status, late model $lateModel",
    ({ status, model, lateModel }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
        }).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    // Recorded Cursor task calls (see fixtures/subagent) stream a
                    // partial-tool-call before tool-call-started with the same args.
                    // The run then ends without tool-call-completed, which a live
                    // run cannot produce on demand.
                    const taskToolCall = {
                      type: "task" as const,
                      args: {
                        description: "Review",
                        prompt: "Review the code.",
                        subagentType: { kind: "unspecified" },
                        ...(model === undefined ? {} : { model }),
                        agentId: "cursor-task-agent",
                        mode: "unspecified" as const,
                      },
                    };
                    const updates =
                      lateModel !== undefined
                        ? (["tool-call-started", "tool-call-completed"] as const)
                        : (["partial-tool-call", "tool-call-started"] as const);
                    for (const type of updates) {
                      yield* input.onDelta!({
                        type,
                        modelCallId: "model-call",
                        callId: "task-call",
                        toolCall: {
                          ...taskToolCall,
                          args: {
                            ...taskToolCall.args,
                            ...(type === "tool-call-completed"
                              ? { model: lateModel ?? undefined }
                              : {}),
                          },
                        },
                      }).pipe(Effect.orDie);
                    }
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              }),
          }),
          Effect.provide(layerTestProviderHost({ cwd: workspace })),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
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
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
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
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(rows[0]?.subagent.model, model ?? null);
        assert.equal(rows.at(-1)?.subagent.model, lateModel ?? model ?? null);
        assert.equal(
          rows.at(-1)?.subagent.status,
          lateModel !== undefined
            ? "completed"
            : status === "finished"
              ? "idle"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("fails standalone SDK transport diagnostics and sends compaction as /compress", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-errors-" });
      const sentMessages: Array<string> = [];
      let sendCalls = 0;
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-transport-error-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-error",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sendCalls += 1;
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  const runId = `native-cursor-run-${sendCalls}`;
                  return {
                    agentId: "native-cursor-error",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-request-${sendCalls}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                      ...(sendCalls === 1
                        ? { result: "Error: RetriableError: WritableIterable is closed" }
                        : {}),
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(layerTestProviderHost({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-error-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-error-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor transport failure",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
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
      };
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-error-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-error-attempt"),
        rootNodeId: NodeId.make("cursor-error-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-error-message"),
          createdBy: "user",
          creationSource: "web",
          text: "continue",
          attachments: [],
        },
      });
      const first = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(first));
      if (Option.isSome(first)) {
        assert.equal(first.value.status, "failed");
        assert.equal(first.value.failure?.class, "transport_error");
      }

      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-compact-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("cursor-compact-attempt"),
        rootNodeId: NodeId.make("cursor-compact-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-compact-message"),
          createdBy: "user",
          creationSource: "web",
          text: "ignored by compactThread",
          attachments: [],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(sentMessages[1], "/compress");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("projects Cursor directory trees and lint diagnostics as file search results", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-search-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-search-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const emptyLsNode = {
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: true,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      };
      const updates: ReadonlyArray<InteractionUpdate> = [
        ...(["tool-call-started", "tool-call-completed"] as const).map((type) => ({
          type,
          modelCallId: "native-model-call",
          callId: "mcp-weather",
          toolCall: {
            type: "mcp" as const,
            args: {
              providerIdentifier: "weather",
              toolName: "get_weather",
              args: { city: "Berlin" },
            },
            ...(type === "tool-call-completed"
              ? { result: { status: "success" as const, value: { content: [], isError: false } } }
              : {}),
          },
        })),
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "read-file",
          toolCall: {
            type: "read",
            args: { path: "src/env.ts" },
            result: {
              status: "success",
              value: { fileSize: 12, content: "---\nfile body", totalLines: 2 },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-nested",
          toolCall: {
            type: "ls",
            args: { path: workspace },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: {
                  ...emptyLsNode,
                  absPath: workspace,
                  childrenFiles: [{ name: "README.md" }],
                  childrenDirs: [
                    {
                      ...emptyLsNode,
                      absPath: path.join(workspace, "src"),
                      childrenFiles: [{ name: "index.ts" }],
                      childrenDirs: [
                        {
                          ...emptyLsNode,
                          absPath: path.join(workspace, "src", "nested"),
                          childrenFiles: [{ name: "util.ts" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-empty",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "empty") },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: { ...emptyLsNode, absPath: path.join(workspace, "empty") },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-failed",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "missing") },
            result: { status: "error", error: "ENOENT" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "grep-failed",
          toolCall: {
            type: "grep",
            args: { pattern: "TODO", path: "src" },
            result: { status: "error", error: "search failed" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "glob-failed",
          toolCall: {
            type: "glob",
            args: { globPattern: "*.ts" },
            result: { status: "error", error: "search failed" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts", "src/b.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 2,
                totalDiagnostics: 3,
                fileDiagnostics: [
                  {
                    path: "src/a.ts",
                    diagnosticsCount: 2,
                    diagnostics: [
                      {
                        message: "Unused variable",
                        code: "TS6133",
                        source: "ts",
                        severity: "warning",
                        range: { start: { line: 0, character: 4 } },
                      },
                      {
                        message: "Cannot find name",
                        code: "TS2304",
                        source: "ts",
                        severity: "error",
                        range: { start: { line: 11 } },
                      },
                    ],
                  },
                  {
                    path: "src/b.ts",
                    diagnosticsCount: 1,
                    diagnostics: [
                      {
                        message: "File-level diagnostic",
                        code: "TS0",
                        source: "ts",
                        severity: "information",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-empty",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/clean.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 1,
                totalDiagnostics: 0,
                fileDiagnostics: [{ path: "src/clean.ts", diagnosticsCount: 0, diagnostics: [] }],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-failed",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts"] },
            result: { status: "error", error: "lint failed" },
          },
        },
      ];
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-search",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  for (const update of updates) {
                    if (input.onDelta !== undefined) {
                      yield* input.onDelta(update).pipe(Effect.orDie);
                    }
                  }
                  return {
                    agentId: "native-cursor-search",
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
                }),
            }),
        }),
        Effect.provide(layerTestProviderHost({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-search-session"),
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
        runId: RunId.make("cursor-search-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-search-attempt"),
        rootNodeId: NodeId.make("cursor-search-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-search-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor search results",
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
          messageId: MessageId.make("cursor-search-message"),
          createdBy: "user",
          creationSource: "web",
          text: "inspect the workspace",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const mcpItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "mcp__weather__get_weather"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        mcpItems.map((item) => item.status),
        ["running", "completed"],
      );
      for (const item of mcpItems) {
        assert.equal(item.title, "get weather");
        assert.deepEqual(item.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(item.input, {
          providerIdentifier: "weather",
          toolName: "get_weather",
          args: { city: "Berlin" },
        });
      }
      const fileSearchItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "file_search" &&
        event.turnItem.status !== "running"
          ? [event.turnItem]
          : [],
      );
      const readItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "Read" &&
        event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        readItems.map((item) => ({ title: item.title, input: item.input })),
        [{ title: "Read src/env.ts", input: { path: "src/env.ts" } }],
      );
      assert.deepEqual(
        fileSearchItems.map((item) => ({
          pattern: item.pattern,
          status: item.status,
          results: item.results,
        })),
        [
          {
            pattern: workspace,
            status: "completed",
            results: [
              { fileName: path.join(workspace, "README.md") },
              { fileName: path.join(workspace, "src", "index.ts") },
              { fileName: path.join(workspace, "src", "nested", "util.ts") },
            ],
          },
          {
            pattern: path.join(workspace, "empty"),
            status: "completed",
            results: undefined,
          },
          {
            pattern: path.join(workspace, "missing"),
            status: "failed",
            results: [{ fileName: path.join(workspace, "missing"), preview: "ENOENT" }],
          },
          {
            pattern: "TODO",
            status: "failed",
            results: [{ fileName: "src", preview: "search failed" }],
          },
          {
            pattern: "*.ts",
            status: "failed",
            results: [{ fileName: ".", preview: "search failed" }],
          },
          {
            pattern: "src/a.ts, src/b.ts",
            status: "completed",
            results: [
              { fileName: "src/a.ts", line: 1, column: 5, preview: "Unused variable" },
              { fileName: "src/a.ts", line: 12, preview: "Cannot find name" },
              { fileName: "src/b.ts", preview: "File-level diagnostic" },
            ],
          },
          {
            pattern: "src/clean.ts",
            status: "completed",
            results: undefined,
          },
          {
            pattern: "src/a.ts",
            status: "failed",
            results: [{ fileName: "src/a.ts", preview: "lint failed" }],
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

  it("maps Cursor auto and model parameters to SDK selections", () => {
    assert.deepEqual(
      cursorSdkModelSelection({
        instanceId: ProviderInstanceId.make("cursor"),
        model: "auto",
        options: [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      }),
      {
        id: "default",
        params: [
          { id: "thinking", value: "high" },
          { id: "context", value: "1m" },
          { id: "fast", value: "true" },
        ],
      },
    );
  });

  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "auto-accept-edits",
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
      }),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
  });

  it("loads the user's Cursor settings layers in every runtime mode", () => {
    // The SDK loads no rules, skills, hooks, or MCP config from disk unless
    // settingSources names them, so an omitted list silently drops AGENTS.md.
    for (const runtimeMode of ["full-access", "auto-accept-edits", "approval-required"] as const) {
      const options = makeCursorAgentOptions({
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2.5",
        },
        runtimePolicy: { runtimeMode, interactionMode: "default", cwd: "/workspace" },
        threadId: ThreadId.make("thread-cursor-setting-sources"),
        mcpSession: undefined,
      });
      assert.deepEqual(options.local?.settingSources, [
        "project",
        "user",
        "team",
        "mdm",
        "plugins",
      ]);
    }
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
