import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CursorSettings,
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
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  CursorProviderCapabilitiesV2,
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./CursorAdapterV2.ts";
import { isCursorCancellationError, loggedCursorAgentOptions } from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  it.effect("sends discovered skills as native slash invocations with runtime instructions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-skills-" });
      const skillDirectory = path.join(workspace, ".cursor", "skills", "review");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        "---\nname: review\n---\nReview the changes.",
      );
      const sentMessages: Array<string> = [];
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-skills-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
        fileSystem,
        path,
        idAllocator: yield* IdAllocatorV2,
        serverConfig: yield* ServerConfig.pipe(
          Effect.provide(serverConfigLayerTest(workspace, { prefix: "cursor-v2-skills-config-" })),
        ),
        runner: {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-skills",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  return {
                    agentId: "native-cursor-skills",
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
        },
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-skills-session"),
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
        runId: RunId.make("cursor-skills-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-skills-attempt"),
        rootNodeId: NodeId.make("cursor-skills-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-skills-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor skills",
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
          messageId: MessageId.make("cursor-skills-message"),
          createdBy: "user",
          creationSource: "web",
          text: "$review this with $HOME and $missing",
          attachments: [],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.lengthOf(sentMessages, 1);
      assert.isTrue(sentMessages[0]!.startsWith("/review this with $HOME and $missing\n\n"));
      assert.include(sentMessages[0]!, "Cursor");
      assert.include(sentMessages[0]!, "T3 Code");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, idAllocatorLayer))),
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

  it("advertises only capabilities exposed by the official SDK adapter", () => {
    assert.isTrue(CursorProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canForkThread);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canRollbackThread);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isFalse(CursorProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(CursorProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(CursorProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isFalse(CursorProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.equal(CursorProviderCapabilitiesV2.identity.nativeItemIds, "weak");
    assert.isFalse(CursorProviderCapabilitiesV2.approvals.supportsCommandApproval);
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    });

    try {
      assert.deepEqual(cursorMcpServers(threadId), {
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
      });
      assert.deepEqual(options.mcpServers, cursorMcpServers(threadId));

      const logged = JSON.stringify(loggedCursorAgentOptions(options));
      assert.notInclude(logged, "secret-cursor-api-key");
      assert.notInclude(logged, "secret-cursor-mcp-token");
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(isCursorCancellationError(new Error("request failed")));
    assert.isFalse(isCursorCancellationError(null));
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
