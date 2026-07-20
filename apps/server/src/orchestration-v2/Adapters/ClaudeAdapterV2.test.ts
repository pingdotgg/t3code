import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  ChatImageAttachment,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Tool } from "effect/unstable/ai";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import type { ProviderContinuationRequest } from "../ProviderContinuationRequests.ts";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  CLAUDE_DEFAULT_INSTANCE_ID,
  CLAUDE_PROVIDER,
  CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
  CLAUDE_T3_MCP_TOOL_WILDCARD,
  ClaudeProviderCapabilitiesV2,
  claudeEffectiveQueryPolicyKey,
  claudeMcpQueryOverrides,
  claudeQueryMessages,
  claudeRuntimeQueryPolicyForRuntimePolicy,
  loggedClaudeQueryOptions,
  makeClaudeAdapterV2,
  makeClaudeAgentSdkProtocolLogger,
  makeClaudeQueryOptions,
  type ClaudeAgentSdkQueryOptions,
  type ClaudeAgentSdkQueryOpenInput,
} from "./ClaudeAdapterV2.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
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

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly messageCreatedBy?: ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapterV2TurnInput["message"]["creationSource"];
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 runtime query policy", () => {
  it("maps canonical read-only never policy to Claude dontAsk with read-only tools", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps canonical read-only on-request policy to Claude default with callbacks", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: true,
    });
  });

  it("does not auto-allow reads for canonical restricted read-only never policy", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: [],
          },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps default full-access policy to Claude bypass permissions", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });

  it("keeps approval-required mode interactive with danger-full-access sandboxing", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      installPermissionCallback: true,
    });
  });

  it("installs the permission callback for approval-required plan mode", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "plan",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "plan",
      installPermissionCallback: true,
    });
  });

  it("honors never approvals for approval-required workspace-write policy", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      installPermissionCallback: false,
    });
  });

  it("honors never approvals for externally sandboxed policy", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "externalSandbox",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const T3_MCP_SERVERS = {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
    },
  } as const;

  const withMcpSession = (threadId: ThreadId, run: () => void) => {
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make(`environment-${threadId}`),
      threadId,
      providerSessionId: `mcp-session-${threadId}`,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
    });
    try {
      run();
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  };

  it("leaves an absent allowlist absent when no MCP session exists", () => {
    const overrides = claudeMcpQueryOverrides({
      threadId: ThreadId.make("thread-claude-no-mcp-no-allowlist"),
      readOnlySandbox: false,
    });

    assert.deepEqual(overrides, {});
  });

  it("preserves an explicit allowlist when no MCP session exists", () => {
    const overrides = claudeMcpQueryOverrides({
      threadId: ThreadId.make("thread-claude-no-mcp-with-allowlist"),
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });

    assert.deepEqual(overrides, { allowedTools: ["Read"] });
  });

  it("pre-approves all t3-code tools when attaching an MCP session without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-no-allowlist");
    withMcpSession(threadId, () => {
      const overrides = claudeMcpQueryOverrides({ threadId, readOnlySandbox: false });

      assert.deepEqual(overrides, {
        allowedTools: [CLAUDE_T3_MCP_TOOL_WILDCARD],
        mcpServers: T3_MCP_SERVERS,
      });
    });
  });

  it("extends an explicit allowlist with the t3-code wildcard", () => {
    const threadId = ThreadId.make("thread-claude-mcp-with-allowlist");
    withMcpSession(threadId, () => {
      const overrides = claudeMcpQueryOverrides({
        threadId,
        readOnlySandbox: false,
        allowedTools: ["Read", "mcp__t3-code__*"],
      });

      assert.deepEqual(overrides, {
        allowedTools: ["Read", "mcp__t3-code__*"],
        mcpServers: T3_MCP_SERVERS,
      });
    });
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    withMcpSession(threadId, () => {
      const overrides = claudeMcpQueryOverrides({
        threadId,
        readOnlySandbox: true,
        allowedTools: [...CLAUDE_READ_ONLY_ALLOWED_TOOLS],
      });

      assert.deepEqual(overrides, {
        allowedTools: [...CLAUDE_READ_ONLY_ALLOWED_TOOLS, ...CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS],
        mcpServers: T3_MCP_SERVERS,
      });
      assert.isFalse(overrides.allowedTools?.includes(CLAUDE_T3_MCP_TOOL_WILDCARD));
    });
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox without an allowlist", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only-no-allowlist");
    withMcpSession(threadId, () => {
      const overrides = claudeMcpQueryOverrides({ threadId, readOnlySandbox: true });

      assert.deepEqual(overrides.allowedTools, [...CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS]);
    });
  });

  it("keys live-query reuse on the MCP-derived pre-approvals", () => {
    const threadId = ThreadId.make("thread-claude-mcp-query-key");
    withMcpSession(threadId, () => {
      const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        }),
      );

      const readOnlyKey = claudeEffectiveQueryPolicyKey(
        queryPolicy,
        claudeMcpQueryOverrides({ threadId, readOnlySandbox: true }),
      );
      const fullAccessKey = claudeEffectiveQueryPolicyKey(
        queryPolicy,
        claudeMcpQueryOverrides({ threadId, readOnlySandbox: false }),
      );
      const detachedKey = claudeEffectiveQueryPolicyKey(queryPolicy, {});

      assert.notEqual(readOnlyKey, fullAccessKey);
      assert.notEqual(fullAccessKey, detachedKey);
    });
  });

  it("invalidates live-query reuse when MCP credentials rotate", () => {
    const threadId = ThreadId.make("thread-claude-mcp-credential-rotation");
    withMcpSession(threadId, () => {
      const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        }),
      );
      const initialKey = claudeEffectiveQueryPolicyKey(
        queryPolicy,
        claudeMcpQueryOverrides({ threadId, readOnlySandbox: false }),
      );

      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make(`environment-${threadId}`),
        threadId,
        providerSessionId: `mcp-session-${threadId}`,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer rotated-claude-token",
      });

      const rotatedKey = claudeEffectiveQueryPolicyKey(
        queryPolicy,
        claudeMcpQueryOverrides({ threadId, readOnlySandbox: false }),
      );
      assert.notEqual(rotatedKey, initialKey);
    });
  });

  it("matches the read-only allowlist to the orchestrator toolkit annotations", () => {
    const readOnlyToolNames = Object.values(OrchestratorToolkit.tools)
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => `mcp__t3-code__${tool.name}`)
      .sort();

    assert.deepEqual([...CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS].sort(), readOnlyToolNames);
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
    });

    try {
      const overrides = claudeMcpQueryOverrides({
        threadId,
        readOnlySandbox: false,
        allowedTools: ["Read"],
      });
      assert.deepEqual(overrides, {
        allowedTools: ["Read", "mcp__t3-code__*"],
        mcpServers: {
          "t3-code": {
            type: "http",
            url: "http://127.0.0.1:43123/mcp",
            headers: {
              Authorization: "Bearer secret-claude-token",
            },
          },
        },
      });

      const options = makeClaudeQueryOptions({
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        nativeThreadId: "native-thread-claude-mcp",
        resume: false,
        cwd: "/workspace",
        ...overrides,
      });
      const logged = loggedClaudeQueryOptions(options);
      assert.equal(logged.hasMcpServers, true);
      assert.notInclude(JSON.stringify(logged), "secret-claude-token");
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it.effect("writes Claude Agent SDK protocol frames to the native provider log", () =>
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
      const protocolLogger = makeClaudeAgentSdkProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          type: "query.interrupt",
        },
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "claudeAgent",
        protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "query.interrupt",
          },
        },
      });
    }),
  );

  it("does not install a protocol logger when native logging is unavailable", () => {
    const protocolLogger = makeClaudeAgentSdkProtocolLogger({
      nativeEventLogger: undefined,
      threadId: ThreadId.make("thread-1"),
      providerSessionId: ProviderSessionId.make("provider-session-1"),
    });

    assert.equal(protocolLogger, undefined);
  });

  it("logs query options without leaking environment values or callback functions", () => {
    const options: ClaudeAgentSdkQueryOptions = {
      model: "claude-sonnet-4-6",
      tools: {
        type: "preset",
        preset: "claude_code",
      },
      permissionMode: "default",
      sessionId: "native-thread-1",
      cwd: "/workspace",
      env: {
        ANTHROPIC_API_KEY: "secret",
      },
      extraArgs: {
        "append-system-prompt": "secret launch prompt",
      },
      canUseTool: (_toolName, input, callbackOptions) =>
        Promise.resolve({
          behavior: "allow",
          updatedInput: input,
          toolUseID: callbackOptions.toolUseID,
          decisionClassification: "user_temporary",
        }),
    };

    assert.deepEqual(loggedClaudeQueryOptions(options), {
      model: "claude-sonnet-4-6",
      tools: {
        type: "preset",
        preset: "claude_code",
      },
      permissionMode: "default",
      sessionId: "native-thread-1",
      cwd: "/workspace",
      hasCanUseTool: true,
      hasEnvironment: true,
      hasExtraArgs: true,
    });
    assert.notInclude(JSON.stringify(loggedClaudeQueryOptions(options)), "secret launch prompt");
  });
});

describe("ClaudeAdapterV2 attachments", () => {
  it.effect("forwards persisted images on initial turns and live steering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-attachments-",
        });
        const offeredMessages: Array<SDKUserMessage> = [];
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
            open: () =>
              Effect.succeed({
                messages: Stream.never,
                offer: (message) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-attachments");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const attachment = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
          ),
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, attachmentRelativePath(attachment)),
          Uint8Array.from([1, 2, 3, 4]),
        );
        const attemptId = RunAttemptId.make("attempt-claude-attachments");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId,
            text: "What's in this image?",
            attachments: [attachment],
          }),
        );

        const expectedImageBlock = {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        } as const;
        assert.deepEqual(offeredMessages[0]?.message.content, [
          { type: "text", text: "Ultrathink:\nWhat's in this image?" },
          expectedImageBlock,
        ]);

        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run-claude-attachments"),
          providerThread,
          providerTurnId,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-attachments-steer"),
            text: "Focus on the diagram labels.",
            attachments: [attachment],
          },
        });

        assert.equal(offeredMessages[1]?.priority, "now");
        assert.deepEqual(offeredMessages[1]?.message.content, [
          { type: "text", text: "Ultrathink:\nFocus on the diagram labels." },
          expectedImageBlock,
        ]);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("rejects unsupported image types before opening a provider query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-unsupported-attachment-",
        });
        let openCount = 0;
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-unsupported-attachment"),
            open: () =>
              Effect.sync(() => {
                openCount += 1;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-unsupported-attachment");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-claude-unsupported-attachment",
          ),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const attachment = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-claude-unsupported-12345678-1234-1234-1234-123456789abc",
          ),
          name: "diagram.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 4,
        });
        const now = yield* DateTime.now;

        const error = yield* runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-unsupported-attachment"),
              text: "Inspect this image.",
              attachments: [attachment],
            }),
          )
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterTurnStartError");
        assert.include(String(error.cause), "Unsupported Claude image attachment type");
        assert.equal(openCount, 0);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );
});

describe("ClaudeAdapterV2 native fork", () => {
  it("advertises Claude Agent SDK session forks", () => {
    assert.equal(ClaudeProviderCapabilitiesV2.threads.canForkThread, true);
    assert.equal(ClaudeProviderCapabilitiesV2.threads.canForkFromTurn, true);
  });

  it.effect("forks at the source assistant cursor and resumes the forked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-fork-attachments-",
        });
        const openedQueries: Array<ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<{
          readonly sessionId: string;
          readonly options: unknown;
          readonly threadId: ThreadId;
          readonly providerSessionId: ProviderSessionId;
        }> = [];
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("source-native-session"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: (input) =>
              Effect.sync(() => {
                forkCalls.push(input);
                return { sessionId: "forked-native-session" };
              }),
            assertComplete: Effect.void,
          },
        });
        const providerSessionId = ProviderSessionId.make("provider-session-claude-fork");
        const sourceThreadId = ThreadId.make("thread-claude-fork-source");
        const targetThreadId = ThreadId.make("thread-claude-fork-target");
        const runtime = yield* adapter.openSession({
          threadId: sourceThreadId,
          providerSessionId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const sourceProviderThread = yield* runtime.ensureThread({
          threadId: sourceThreadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("provider-turn-claude-source");
        const forkedProviderThread = yield* runtime.forkThread({
          sourceProviderThread,
          sourceProviderTurns: [
            {
              id: providerTurnId,
              providerThreadId: sourceProviderThread.id,
              nodeId: NodeId.make("node-claude-source"),
              runAttemptId: RunAttemptId.make("run-attempt-claude-source"),
              nativeTurnRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: "assistant-message-cursor",
                strength: "weak",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurnId,
          targetThreadId,
        });

        assert.deepEqual(forkCalls, [
          {
            sessionId: "source-native-session",
            options: {
              dir: "/workspace",
              upToMessageId: "assistant-message-cursor",
            },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "forked-native-session");
        assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, providerTurnId);

        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: targetThreadId,
            projectId: ProjectId.make("project-claude-fork-target"),
            title: "Claude fork target",
            providerInstanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
            modelSelection: {
              instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: forkedProviderThread.id,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
          },
          threadId: targetThreadId,
          runId: RunId.make("run-claude-fork-target"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt-claude-fork-target"),
          rootNodeId: NodeId.make("node-claude-fork-target-root"),
          providerThread: forkedProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-fork-target"),
            text: "Respond with fork ok",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });

        assert.equal(openedQueries[0]?.options.resume, "forked-native-session");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );
});

describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (providerTurnOrdinal: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-session-identity-",
        });
        const openedQueries: Array<ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
          }),
        );
        return openedQueries;
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    );

  it.effect("creates the native session on the first provider turn", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(1);
      assert.equal(openedQueries.length, 1);
      assert.equal(openedQueries[0]?.options.sessionId, "native-session-identity");
      assert.equal(openedQueries[0]?.options.resume, undefined);
    }),
  );

  it.effect(
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }),
  );
});

describe("ClaudeAdapterV2 background wake turns", () => {
  const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
  const WAKE_TASK_ID = "task-wake-build";
  const WAKE_SUMMARY = "Background build completed successfully";
  const WAKE_RESULT_TEXT = "The background build finished; everything passed.";

  function claudeSdkFrame(frame: unknown): SDKMessage {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof Reflect.get(frame, "type") !== "string"
    ) {
      throw new Error("Frame is not a Claude Agent SDK message.");
    }
    return frame as SDKMessage;
  }

  const wakeTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WAKE_TASK_ID,
    description: "npm run build",
    task_type: "local_bash",
    uuid: "00000000-0000-4000-8000-000000000101",
    session_id: WAKE_NATIVE_SESSION,
  });
  const makeResultFrame = (input: { readonly uuid: string; readonly result: string }) =>
    claudeSdkFrame({
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: false,
      num_turns: 1,
      result: input.result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const turnOneResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000102",
    result: "Kicked off the build in the background.",
  });
  const wakeNotification = claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: WAKE_TASK_ID,
    status: "completed",
    output_file: "/tmp/task-wake-build.log",
    summary: WAKE_SUMMARY,
    uuid: "00000000-0000-4000-8000-000000000103",
    session_id: WAKE_NATIVE_SESSION,
  });
  const wakeResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000104",
    result: WAKE_RESULT_TEXT,
  });

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

  const makeWakeHarness = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const offeredMessages: Array<SDKUserMessage> = [];
    const continuationRequests: Array<ProviderContinuationRequest> = [];
    const adapter = makeClaudeAdapterV2({
      instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }),
      },
      queryRunner: {
        allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: (message) =>
              Effect.sync(() => {
                offeredMessages.push(message);
              }),
            setModel: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused forkSession"),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
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
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      offeredMessages,
      continuationRequests,
      events,
      terminalEvents,
      hasPendingBackgroundWork,
    };
  });

  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* Queue.offer(harness.sdkMessages, wakeResult);
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "wake result to settle into the buffer");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("drains buffered wake messages into a continuation turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-2a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-2b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        // The continuation prompt never reaches the CLI; only the first turn
        // offered a user message.
        assert.lengthOf(harness.offeredMessages, 1);
        // The wake result text surfaces as the continuation turn's assistant
        // output.
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        // The background task never renders as a subagent node.
        assert.isFalse(
          harness.events.some((event) => JSON.stringify(event).includes(WAKE_TASK_ID)),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("leaves buffered wake messages for the continuation queued behind a user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4b"),
            text: "How is the build going?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );

        // The user prompt reaches the CLI and the buffer stays untouched: the
        // wake result must not settle the user turn or surface under it.
        yield* awaitUntil(() => harness.offeredMessages.length === 2, "user prompt offered");
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000105",
            result: "The build passed; nothing else pending.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "user turn terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );

        // The continuation run queued behind the user turn drains the wake
        // output afterwards.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "continuation terminal");
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        assert.isFalse(
          harness.events.some((event) => JSON.stringify(event).includes(WAKE_TASK_ID)),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("clears the pending task when the wake notification carries no summary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-5a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: WAKE_TASK_ID,
            status: "completed",
            output_file: "/tmp/task-wake-build.log",
            summary: null,
            uuid: "00000000-0000-4000-8000-000000000106",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.isNull(harness.continuationRequests[0]?.detail);

        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-5b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("settles a continuation turn immediately when no wake output is buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-3"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "spurious terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 0);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("wakes and hydrates a subagent that completes after the root turn settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-wake-subagent";
        const SUBAGENT_SUMMARY = "SUB_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly SUB_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000201",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-wake-subagent.output",
          summary: SUBAGENT_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000202",
          session_id: WAKE_NATIVE_SESSION,
        });
        // The SDK resolves a background Agent tool_use immediately with an
        // async-launch ACK; it must not terminalize the subagent.
        const subagentAsyncAck = claudeSdkFrame({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: SUBAGENT_TOOL_USE_ID,
                content: [{ type: "text", text: "Async agent launched successfully." }],
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000205",
          session_id: WAKE_NATIVE_SESSION,
          tool_use_result: {
            isAsync: true,
            status: "async_launched",
            agentId: SUBAGENT_TASK_ID,
            prompt: "Run the shell command, then return exactly SUB_SETTLE_DONE.",
          },
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-6a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        assert.equal(subagentEvents()[0]?.subagent.status, "running");
        yield* Queue.offer(harness.sdkMessages, subagentAsyncAck);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        // The ACK tool_result did not terminalize the row, and a still-running
        // subagent pins idle release like a background task.
        assert.equal(subagentEvents().at(-1)?.subagent.status, "running");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* Queue.offer(harness.sdkMessages, subagentNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.detail, SUBAGENT_SUMMARY);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000204",
            result: "The subagent finished with SUB_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-6b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");

        // The replayed notification hydrates the original subagent node with
        // its terminal status and result, and keeps the original run
        // attribution instead of re-parenting to the continuation run.
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SUBAGENT_SUMMARY);
        assert.equal(finalSubagent?.runId, subagentEvents()[0]?.subagent.runId);
        const subagentNodeEvents = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" &&
            event.node.kind === "subagent" &&
            event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
        );
        const finalSubagentNode = subagentNodeEvents.at(-1)?.node;
        assert.equal(finalSubagentNode?.status, "completed");
        assert.equal(finalSubagentNode?.runId, subagentNodeEvents[0]?.node.runId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("releases the idle pin when a post-settle subagent stops without completing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-wake-subagent-stopped";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          description: "Long-running research task",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Investigate the flaky test.",
          uuid: "00000000-0000-4000-8000-000000000301",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentStoppedNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: "toolu-wake-subagent-stopped",
          status: "stopped",
          output_file: "/tmp/task-wake-subagent-stopped.output",
          summary: "Agent was stopped before finishing.",
          uuid: "00000000-0000-4000-8000-000000000302",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000303",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, subagentStoppedNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000304",
            result: "The subagent was stopped.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-7b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        assert.equal(subagentEvents().at(-1)?.subagent.status, "cancelled");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("re-opens a resumed subagent and hydrates its second result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-subagent";
        const RESUME_TOOL_USE_ID = "toolu-resume-sendmessage";
        const FIRST_SUMMARY = "Timer armed. Waiting for it to complete.";
        const SECOND_SUMMARY = "RESUME_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_DONE.",
          uuid: "00000000-0000-4000-8000-000000000401",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-subagent.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000402",
          session_id: WAKE_NATIVE_SESSION,
        });
        // SendMessage to a completed subagent resumes it: the CLI re-emits
        // task_started with the same task id but the SendMessage call's
        // tool_use_id, not the original Agent launch's.
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_DONE.",
          uuid: "00000000-0000-4000-8000-000000000405",
          session_id: WAKE_NATIVE_SESSION,
        });
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-subagent.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000407",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-8a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000403",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 1,
          "first continuation request",
        );
        assert.equal(harness.continuationRequests[0]?.detail, FIRST_SUMMARY);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000404",
            result: "The subagent finished early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-8b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        // A user turn nudges the completed subagent via SendMessage; the
        // resume task_started re-opens the row across turn contexts (the new
        // turn's maps are empty, so this exercises the session registry).
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-8c"),
            text: "Nudge the subagent to finish.",
            attachments: [],
            providerTurnOrdinal: 3,
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 2, "nudge prompt offered");
        // The resume rides on a SendMessage tool call: the CLI re-emits
        // task_started with the SendMessage tool_use_id, and that tool call's
        // result is a delivery ACK which must not terminalize the subagent.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: { agent_id: SUBAGENT_TASK_ID, message: "Continue and return the token." },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000411",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: RESUME_TOOL_USE_ID,
                  content: [
                    {
                      type: "text",
                      text: '{"success":true,"message":"Message sent to agent; it will resume."}',
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000412",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => subagentEvents().at(-1)?.subagent.status === "running",
          "subagent re-opened",
        );
        const reopened = subagentEvents().at(-1)?.subagent;
        assert.isNull(reopened?.result);
        // The reopen re-attributes the subagent to the resuming run:
        // RunExecutionService routes parent-thread events by runId, and the
        // launch run's ingestion fiber stops once its child subagents
        // terminalize, so only the resuming run's fiber can persist the
        // resumed lifecycle.
        assert.equal(reopened?.runId, "run-attempt-claude-wake-8c");
        assert.notEqual(reopened?.runId, subagentEvents()[0]?.subagent.runId);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000406",
            result: "Nudged the subagent.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "nudge turn terminal");
        // The re-opened subagent pins idle release again.
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        // The resumed run's notification is wake evidence again and carries
        // its summary as the continuation detail.
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 2,
          "second continuation request",
        );
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000408",
            result: "The subagent finished with RESUME_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-8d"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 4,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 4,
          "second continuation terminal",
        );

        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        // The completion keeps the resuming run's attribution.
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-8c");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        // Only task_started may re-open a terminal subagent: a late
        // task_progress must not flip the row back to running or re-pin idle.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-8e"),
            text: "Anything new?",
            attachments: [],
            providerTurnOrdinal: 5,
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 3, "final prompt offered");
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Stale progress line",
            uuid: "00000000-0000-4000-8000-000000000409",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000410",
            result: "Nothing new.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 5, "final turn terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, SECOND_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("re-opens a resumed subagent whose task_started races past settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-postsettle";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-postsettle";
        const RESUME_TOOL_USE_ID = "toolu-resume-postsettle-sendmessage";
        const FIRST_SUMMARY = "Answered early.";
        const SECOND_SUMMARY = "RESUME_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000501",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000502",
          session_id: WAKE_NATIVE_SESSION,
        });
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000505",
          session_id: WAKE_NATIVE_SESSION,
        });
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000506",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 1,
          "first continuation request",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000504",
            result: "The subagent answered early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        // The resume task_started races past settle: no turn is active, so it
        // must re-open the session registry entry (pinning idle again) and
        // buffer for replay. Its notification then counts as wake evidence
        // and carries the new summary as the continuation detail. The resume
        // rides on a SendMessage tool call whose frames race past settle too;
        // on drain replay the SendMessage tool_result is a delivery ACK and
        // must not terminalize the re-opened subagent.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: { agent_id: SUBAGENT_TASK_ID, message: "Continue and return the token." },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: RESUME_TOOL_USE_ID,
                  content: [
                    {
                      type: "text",
                      text: '{"success":true,"message":"Message sent to agent; it will resume."}',
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000509",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* awaitUntil(
          () => harness.continuationRequests.length === 2,
          "second continuation request",
        );
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000507",
            result: "The subagent finished with RESUME_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 3,
          "resume continuation terminal",
        );

        // The drained replay re-opens the row (running, stale result cleared)
        // before the second notification terminalizes it again.
        const statuses = subagentEvents().map((event) => event.subagent.status);
        const firstCompleted = statuses.indexOf("completed");
        const reopenedIndex = statuses.lastIndexOf("running");
        assert.isAbove(reopenedIndex, firstCompleted);
        assert.isNull(subagentEvents()[reopenedIndex]?.subagent.result);
        // The drain-replayed reopen re-attributes the subagent to the
        // continuation run performing the replay, so that run's ingestion
        // fiber routes the resumed lifecycle and lingers past settle until
        // the resumed task completes.
        assert.equal(subagentEvents()[reopenedIndex]?.subagent.runId, "run-attempt-claude-wake-9c");
        // The execution node re-opens too, even though the registry entry was
        // already pre-opened by the wake buffer before the drain replay.
        const nodeStatuses = harness.events
          .filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          )
          .map((event) => event.node.status);
        assert.isAbove(nodeStatuses.lastIndexOf("running"), nodeStatuses.indexOf("completed"));
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        // The completion keeps the resuming run's attribution.
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-9c");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );
});

describe("ClaudeAdapterV2 query message stream", () => {
  it.effect("closes the query when the message stream is interrupted mid-read", () =>
    Effect.gen(function* () {
      let closed = false;
      let releaseRead = () => {};
      const readStarted = Promise.withResolvers<void>();
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        while (!closed) {
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted.resolve();
          });
        }
      }
      const generator = sdkMessages();
      const close = () => {
        closed = true;
        releaseRead();
      };
      const query = {
        next: () => generator.next(),
        return: async (value?: void) => {
          close();
          return generator.return(value);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]: () => generator,
        close,
      } as unknown as ClaudeQuery;

      const scope = yield* Scope.make();
      yield* Stream.fromAsyncIterable(claudeQueryMessages(query), (cause) => cause).pipe(
        Stream.runForEach(() => Effect.void),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => readStarted.promise);

      // Iterating query[Symbol.asyncIterator]() directly deadlocks here:
      // the raw generator's return() queues behind the in-flight read and
      // scope close never completes.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(closed);
    }),
  );
});
