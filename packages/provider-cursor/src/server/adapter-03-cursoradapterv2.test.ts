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
          callId: "grep-counts",
          toolCall: {
            type: "grep",
            args: { pattern: "TODO", outputMode: "count" },
            result: {
              status: "success",
              value: {
                workspaceResults: {
                  [workspace]: {
                    type: "count",
                    output: {
                      counts: [
                        { file: "src/a.ts", count: 1 },
                        { file: "src/b.ts", count: 3 },
                      ],
                      total: 4,
                    },
                  },
                },
              },
            },
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
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
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
        assert.deepEqual(item.input, { city: "Berlin" });
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
            pattern: "TODO",
            status: "completed",
            results: [
              { fileName: "src/a.ts", preview: "1 match" },
              { fileName: "src/b.ts", preview: "3 matches" },
            ],
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
});
