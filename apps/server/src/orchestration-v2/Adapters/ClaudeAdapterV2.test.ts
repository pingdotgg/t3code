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
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
  ClaudeAgentSdkQueryRunnerError,
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
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
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
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
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
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
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

  it("maps Auto runtime mode to Claude's AI-reviewed permission mode", () => {
    const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "auto",
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
      browserToolsAvailable: true,
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
        browserToolsAvailable: true,
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
      browserToolsAvailable: true,
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
      assert.isObject(options.systemPrompt);
      const systemPrompt = options.systemPrompt as {
        readonly type: string;
        readonly preset: string;
        readonly append?: string;
      };
      assert.equal(systemPrompt.type, "preset");
      assert.equal(systemPrompt.preset, "claude_code");
      assert.include(systemPrompt.append ?? "", "use `delegate_task`");
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
        const expectedAttachmentPath = path.join(
          attachmentsDir,
          attachmentRelativePath(attachment),
        );
        assert.deepEqual(offeredMessages[0]?.message.content, [
          {
            type: "text",
            text: `Ultrathink:\nWhat's in this image?\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]`,
          },
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
          {
            type: "text",
            text: `Ultrathink:\nFocus on the diagram labels.\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]`,
          },
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
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
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
  const WAKE_ASSISTANT_TEXT = "The background build has finished.";
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
  const makeAssistantTextFrame = (input: {
    readonly uuid: string;
    readonly text: string;
    readonly parentToolUseId?: string | null;
  }) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: input.text }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: input.parentToolUseId ?? null,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeResultFrame = (input: {
    readonly uuid: string;
    readonly result: string;
    readonly numTurns?: number;
    readonly origin?: { readonly kind: "task-notification" };
    readonly subtype?: string;
    readonly isError?: boolean;
    readonly errors?: ReadonlyArray<string>;
    readonly apiErrorStatus?: number;
    readonly terminalReason?: string;
  }) =>
    claudeSdkFrame({
      type: "result",
      subtype: input.subtype ?? "success",
      ...(input.terminalReason === undefined ? {} : { terminal_reason: input.terminalReason }),
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: input.isError ?? false,
      num_turns: input.numTurns ?? 1,
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
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.errors === undefined ? {} : { errors: input.errors }),
      ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
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
  const wakeAssistant = claudeSdkFrame({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: WAKE_ASSISTANT_TEXT }],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000107",
    session_id: WAKE_NATIVE_SESSION,
  });
  const wakeResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000104",
    result: WAKE_RESULT_TEXT,
    origin: { kind: "task-notification" },
  });
  const STALE_TASK_NOTIFICATION_RESULT_TEXT =
    "Stale task-notification origin text that must not appear.";
  const staleTaskNotificationResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000106",
    result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
    numTurns: 0,
    origin: { kind: "task-notification" },
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

  const makeWakeHarnessWithOptions = (options?: {
    readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
    readonly interrupt?: Effect.Effect<void>;
    readonly sessionScope?: Scope.Scope;
    readonly runtimePolicy?: typeof CLAUDE_TEST_RUNTIME_POLICY;
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-v2-wake-",
      });
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offeredMessages: Array<SDKUserMessage> = [];
      const openedQueries: Array<ClaudeAgentSdkQueryOpenInput> = [];
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
          open: (input) =>
            Effect.sync(() => {
              openedQueries.push(input);
              return {
                messages: Stream.fromQueue(sdkMessages),
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                interrupt: options?.interrupt ?? Effect.void,
                close: options?.close?.(sdkMessages) ?? Effect.void,
              };
            }),
          forkSession: () => Effect.die("unused forkSession"),
          assertComplete: Effect.void,
        },
      });
      const threadId = ThreadId.make("thread-claude-wake");
      const runtimePolicy = options?.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY;
      const openSession = adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
      });
      const runtime = yield* options?.sessionScope === undefined
        ? openSession
        : openSession.pipe(Effect.provideService(Scope.Scope, options.sessionScope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy,
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
        openedQueries,
        continuationRequests,
        events,
        terminalEvents,
        hasPendingBackgroundWork,
      };
    });
  const makeWakeHarness = makeWakeHarnessWithOptions();

  it.effect("resolves API retries on resumed assistant activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry"),
            text: "Open github.com.",
            attachments: [],
          }),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retryItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
              ? [event.turnItem]
              : [],
          );
        yield* awaitUntil(() => retryItems().length === 1, "Claude retry item");
        const runningRetry = retryItems()[0];
        assert.equal(runningRetry?.status, "running");
        assert.equal(runningRetry?.failure.code, "api_error_529");
        assert.deepEqual(runningRetry?.retry, {
          attempt: 2,
          maxAttempts: 10,
          retryDelayMs: 1_500,
        });

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            text: "Opening GitHub.",
          }),
        );
        yield* awaitUntil(() => retryItems().length === 2, "resolved Claude retry item");
        assert.lengthOf(harness.terminalEvents(), 0);
        const recoveredRetry = retryItems()[1];
        assert.equal(recoveredRetry?.id, runningRetry?.id);
        assert.equal(recoveredRetry?.status, "completed");
        assert.equal(recoveredRetry?.title, "Provider recovered");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Opened GitHub.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "recovered Claude turn");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("carries exhausted retry progress into the terminal provider error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry-exhausted"),
            text: "Open github.com.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 10,
            max_retries: 10,
            retry_delay_ms: 38_010,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000203",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000204",
            result: "Claude is temporarily overloaded.",
            isError: true,
            apiErrorStatus: 529,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed Claude turn");

        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.deepEqual(terminal.retry, {
          attempt: 10,
          maxAttempts: 10,
          retryDelayMs: 38_010,
        });
        assert.isDefined(terminal.retryStartedAt);
        assert.equal(terminal.failure.code, "api_error_529");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  const providerThreadRosterEvents = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
    events.filter(
      (event): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
        event.type === "provider_thread.updated",
    );

  it.effect(
    "projects an authoritative background_tasks_changed roster on the provider thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const rosterSnapshot = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: WAKE_TASK_ID,
                description: "npm run build",
                task_type: "local_bash",
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-roster-snapshot"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, rosterSnapshot);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

          const rosterEvents = providerThreadRosterEvents(harness.events).filter(
            (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
          );
          assert.isAtLeast(rosterEvents.length, 1);
          assert.deepEqual(rosterEvents.at(-1)?.providerThread.pendingBackgroundTasks ?? [], [
            {
              taskId: WAKE_TASK_ID,
              description: "npm run build",
              taskType: "local_bash",
            },
          ]);
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect(
    "uses task_started as an incremental roster fallback and clears on empty snapshot",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const emptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000202",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-roster-fallback"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

          const afterStart = providerThreadRosterEvents(harness.events).filter(
            (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
          );
          assert.isAtLeast(afterStart.length, 1);
          assert.equal(
            (afterStart.at(-1)?.providerThread.pendingBackgroundTasks ?? [])[0]?.taskId,
            WAKE_TASK_ID,
          );

          yield* Queue.offer(harness.sdkMessages, emptyRoster);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(harness.events).some(
                (event) =>
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "empty roster clear",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect("clears the roster when a turn fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const failedResult = claudeSdkFrame({
          type: "result",
          subtype: "error_during_execution",
          duration_ms: 10,
          duration_api_ms: 10,
          is_error: true,
          num_turns: 1,
          result: "boom",
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
          errors: ["boom"],
          uuid: "00000000-0000-4000-8000-000000000203",
          session_id: WAKE_NATIVE_SESSION,
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-roster-fail"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(harness.events).some(
              (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          "roster after task_started",
        );
        yield* Queue.offer(harness.sdkMessages, failedResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const afterFailure = providerThreadRosterEvents(harness.events).at(-1);
        assert.deepEqual(afterFailure?.providerThread.pendingBackgroundTasks ?? [], []);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("clears the native-thread roster when a turn is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-roster-interrupt-",
        });
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const events: Array<ProviderAdapterV2Event> = [];
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(sdkMessages),
                offer: () => Effect.void,
                setModel: () => Effect.void,
                interrupt: Effect.void,
                // End the message stream so interruptTurn's closed wait resolves
                // via stream exit finalize (interrupted status clears roster).
                close: Queue.shutdown(sdkMessages),
              }),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-roster-interrupt");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-roster-interrupt"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-roster-interrupt"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(sdkMessages, wakeTaskStarted);
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(events).some(
              (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          "roster after task_started",
        );

        const providerTurnId = events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: providerTurnId!,
        });
        yield* awaitUntil(
          () =>
            events.some(
              (event) => event.type === "turn.terminal" && event.status === "interrupted",
            ),
          "interrupted terminal",
        );

        const afterInterrupt = providerThreadRosterEvents(events).at(-1);
        assert.deepEqual(afterInterrupt?.providerThread.pendingBackgroundTasks ?? [], []);
        assert.isFalse(yield* runtime.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect(
    "clears the replaced sibling native thread roster when openQuery switches processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-sibling-replace-",
          });
          const nativeIds = ["native-thread-roster-a", "native-thread-roster-b"] as const;
          let allocateIndex = 0;
          // Real two-process model: each openQuery owns its own message queue.
          // A shared queue would mask sibling process death on replacement.
          const processQueues: Array<{
            readonly nativeThreadId: string;
            readonly queue: Queue.Queue<SDKMessage>;
          }> = [];
          const events: Array<ProviderAdapterV2Event> = [];
          const adapter = makeClaudeAdapterV2({
            instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.sync(() => {
                const next =
                  nativeIds[allocateIndex] ?? `native-thread-roster-extra-${allocateIndex}`;
                allocateIndex += 1;
                return next;
              }),
              open: (openInput) =>
                Effect.gen(function* () {
                  const nativeThreadId = openInput.options.sessionId ?? openInput.options.resume;
                  if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
                    return yield* Effect.die("openQuery must supply a native session id");
                  }
                  const queue = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push({ nativeThreadId, queue });
                  return {
                    messages: Stream.fromQueue(queue),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(queue),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              assertComplete: Effect.void,
            },
          });
          const appThreadA = ThreadId.make("thread-claude-roster-a");
          const appThreadB = ThreadId.make("thread-claude-roster-b");
          const runtime = yield* adapter.openSession({
            threadId: appThreadA,
            providerSessionId: ProviderSessionId.make("provider-session-claude-sibling-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadA = yield* runtime.ensureThread({
            threadId: appThreadA,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadB = yield* runtime.ensureThread({
            threadId: appThreadB,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          assert.notEqual(
            providerThreadA.nativeThreadRef?.nativeId,
            providerThreadB.nativeThreadRef?.nativeId,
          );
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          if (runtime.hasPendingBackgroundWorkForThread === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWorkForThread.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const hasPendingBackgroundWorkForThread = runtime.hasPendingBackgroundWorkForThread;
          const now = yield* DateTime.now;
          const taskA = "task-roster-a";
          const taskB = "task-roster-b";

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadA,
              providerThread: providerThreadA,
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-a"),
              text: "Background work on A.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const processA = processQueues[0]!;
          yield* Queue.offer(
            processA.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskA,
              description: "work on A",
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000301",
              session_id: nativeIds[0],
            }),
          );
          yield* Queue.offer(
            processA.queue,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000302",
              result: "A settled with background work.",
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadA.id &&
                  event.status === "completed",
              ),
            "thread A terminal",
          );
          const rosterAAfterSettle = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadA.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterAAfterSettle ?? [], [
            { taskId: taskA, description: "work on A", taskType: "local_bash" },
          ]);
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));

          // Starting B closes A's only live query. A can never emit a roster
          // clear from a dead process, so openQuery must idle-clear A.
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadB,
              providerThread: { ...providerThreadB, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-b"),
              text: "Background work on B.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 2);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadA.id &&
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "sibling A roster cleared idle on process replacement",
          );
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          const processB = processQueues[1]!;
          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskB,
              description: "work on B",
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000303",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.id === providerThreadB.id &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
              ),
            "thread B roster populated",
          );
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isTrue(yield* hasPendingBackgroundWork);
          // Starting B's process clears only B's process-scoped level; A stays
          // empty from the sibling replacement clear above.
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: true,
              num_turns: 1,
              result: "B failed",
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
              errors: ["B failed"],
              uuid: "00000000-0000-4000-8000-000000000304",
              session_id: nativeIds[1],
            }),
          );
          yield* awaitUntil(
            () =>
              events.some(
                (event) =>
                  event.type === "turn.terminal" &&
                  event.providerThreadId === providerThreadB.id &&
                  event.status === "failed",
              ),
            "thread B failed terminal",
          );

          const rosterBAfterFail = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadB.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterBAfterFail ?? [], []);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

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
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 50, "notification-only quiet window");
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);
        assert.equal(harness.continuationRequests[0]?.messageText, "Background task completed.");

        yield* Queue.offer(harness.sdkMessages, wakeResult);
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "wake result to settle into the buffer");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("does not offer a continuation for notification-only opaque work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-notification-only"),
            text: "Start opaque background work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 100, "notification-only quiet window");
        assert.lengthOf(harness.continuationRequests, 0);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-notification-only-continuation"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 2,
          "notification-only continuation terminal",
        );
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 1);
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
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
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
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes an agent server wake from a positive task-notification result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const wakeText = "The background command completed.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-agent-server-wake"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "server",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010b",
            text: wakeText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010c",
            result: wakeText,
            numTurns: 154,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "server wake terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-agent-server-next"),
            text: "What finished?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010d",
            result: "The background command finished.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "queued turn terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes a user mobile turn from a positive task-notification result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const fallbackText = "The ordinary mobile turn completed.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-mobile-notif-origin"),
            text: "Complete this task.",
            attachments: [],
            messageCreationSource: "mobile",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010e",
            result: fallbackText,
            numTurns: 60,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "mobile turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === fallbackText,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("ignores a zero-turn task-notification origin result during a normal user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const probeAssistantText = "Probe after stale task-notification result.";
        const recoveryAssistantText = "Recovered after the interrupt; continuing.";
        const staleResultText = STALE_TASK_NOTIFICATION_RESULT_TEXT;
        const hasMessageText = (text: string) =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === text,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-notif-1"),
            text: "Continue after interrupt.",
            attachments: [],
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 1, "recovery prompt offered");

        // Live interleaving seen after interrupt recovery: a stale stopped
        // task_notification and its task-notification-origin result arrive
        // before the real root assistant stream.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "task-stale-stopped",
            status: "stopped",
            output_file: "/tmp/task-stale-stopped.log",
            summary: "",
            uuid: "00000000-0000-4000-8000-000000000107",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        // Queue-ordered probe: once this assistant text is emitted, the stale
        // origin result ahead of it has been consumed.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: probeAssistantText }],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-00000000010a",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );

        yield* awaitUntil(
          () => hasMessageText(probeAssistantText),
          "probe assistant after stale task-notification result",
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(hasMessageText(staleResultText));

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: recoveryAssistantText }],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000108",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000109",
            result: recoveryAssistantText,
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "user turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(hasMessageText(recoveryAssistantText));
        assert.isFalse(hasMessageText(staleResultText));
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes a zero-turn task-notification result in a provider continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-zero-continuation-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010f",
            result: "Wake result with no model turns.",
            numTurns: 0,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "post-settlement child output buffered");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-zero-continuation-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect(
    "emits one interrupted terminal for a positive task-notification result racing interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const closeGate = yield* Deferred.make<void>();
          const testScope = yield* Scope.Scope;
          yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
          const interruptStarted = yield* Deferred.make<void>();
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) =>
              Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
            interrupt: Deferred.succeed(interruptStarted, undefined),
          });
          const idAllocator = yield* IdAllocatorV2;
          const now = yield* DateTime.now;
          const attemptId = RunAttemptId.make("attempt-claude-interrupt-positive-notif");
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId,
              text: "Stop this task.",
              attachments: [],
            }),
          );
          yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(interruptStarted);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000115",
              result: "Late result after interrupt.",
              numTurns: 7,
              origin: { kind: "task-notification" },
            }),
          );
          const terminalized = Exit.isSuccess(
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "interrupted terminal",
            ).pipe(Effect.exit),
          );
          yield* Deferred.succeed(closeGate, undefined);
          assert.isTrue(terminalized);
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect("drops zero-turn task-notification debris racing interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeGate = yield* Deferred.make<void>();
        const testScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
        const interruptStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) =>
            Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
          interrupt: Deferred.succeed(interruptStarted, undefined),
        });
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-interrupt-zero-notif");
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });
        const staleText = "Zero-turn debris must not leak.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Stop this task.",
            attachments: [],
          }),
        );
        yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(interruptStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000116",
            result: staleText,
            numTurns: 0,
            origin: { kind: "task-notification" },
          }),
        );
        let debrisYields = 0;
        yield* awaitUntil(() => debrisYields++ >= 50, "zero-turn debris consumed");
        yield* Deferred.succeed(closeGate, undefined);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === staleText,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("clears native child state when an interrupt close times out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          close: () => Deferred.succeed(closeStarted, undefined),
        });
        const idAllocator = yield* IdAllocatorV2;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-interrupt-timeout-cleanup");
        const taskId = "task-interrupt-timeout-subagent";
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Start native background work, then stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: "toolu-interrupt-timeout-subagent",
            description: "Native child that cannot survive query invalidation",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Wait for the parent interrupt.",
            uuid: "00000000-0000-4000-8000-000000000119",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => harness.events.some((event) => event.type === "subagent.updated"),
          "subagent registration before interrupt timeout",
        );
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(closeStarted);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        yield* awaitUntil(
          () => harness.terminalEvents().length === 1,
          "interrupt timeout terminal",
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === taskId &&
                event.subagent.status === "failed",
            ),
          "interrupted subagent terminal",
        );

        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const terminalSubagent = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
        );
        assert.equal(terminalSubagent?.type, "subagent.updated");
        assert.equal(
          terminalSubagent?.type === "subagent.updated" ? terminalSubagent.subagent.status : null,
          "failed",
        );
        assert.equal(
          terminalSubagent?.type === "subagent.updated" ? terminalSubagent.subagent.result : null,
          "Background task ended when its Claude session closed.",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === taskId &&
              event.node.status === "failed",
          ),
          2,
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("finalizes running native children when the Claude session closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessionScope = yield* Scope.make();
        const harness = yield* makeWakeHarnessWithOptions({ sessionScope });
        const now = yield* DateTime.now;
        const taskId = "task-session-close-subagent";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-session-close-cleanup"),
            text: "Start native background work, then close the session.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: "toolu-session-close-subagent",
            description: "Native child invalidated by session close",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Wait for the session to close.",
            uuid: "00000000-0000-4000-8000-000000000706",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === taskId &&
                event.subagent.status === "running",
            ),
          "running subagent before session close",
        );
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Scope.close(sessionScope, Exit.void);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === taskId &&
                event.subagent.status === "failed",
            ),
          "failed subagent after session close",
        );

        const terminalSubagent = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
        );
        assert.equal(terminalSubagent?.type, "subagent.updated");
        assert.equal(
          terminalSubagent?.type === "subagent.updated" ? terminalSubagent.subagent.result : null,
          "Background task ended when its Claude session closed.",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === taskId &&
              event.subagent.status === "failed",
          ),
          1,
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === taskId &&
              event.node.status === "failed",
          ),
          2,
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("preserves an offered continuation when its buffered wake survives replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-continuation-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation offer");
        const offeredContinuation = harness.continuationRequests[0];
        assert.isDefined(offeredContinuation?.dispatchIfCurrent);

        const replacementInput = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-stale-continuation-2"),
          text: "Replace the query policy.",
          attachments: [],
          providerTurnOrdinal: 2,
        });
        yield* harness.runtime.startTurn({
          ...replacementInput,
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
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
        });

        let dispatched = false;
        const guardedDispatch = yield* offeredContinuation!.dispatchIfCurrent!(
          Effect.sync(() => {
            dispatched = true;
          }),
        );
        assert.isTrue(Option.isSome(guardedDispatch));
        assert.isTrue(dispatched);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("clears buffered work when the continuation worker drops an offer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-dropped-continuation"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation offer");
        const offeredContinuation = harness.continuationRequests[0];
        assert.isDefined(offeredContinuation?.clearIfCurrent);
        assert.isDefined(offeredContinuation?.dispatchIfCurrent);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* offeredContinuation!.clearIfCurrent!();

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.isTrue(Option.isNone(yield* offeredContinuation!.dispatchIfCurrent!(Effect.void)));
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("fails a positive task-notification error result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-positive-notif-error"),
            text: "Run the task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000117",
            result: "The task failed.",
            numTurns: 7,
            origin: { kind: "task-notification" },
            subtype: "error_during_execution",
            isError: true,
            errors: ["The task failed."],
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes a continuation turn from a task-notification origin wake result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-notif-origin-2a"),
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
            attemptId: RunAttemptId.make("attempt-claude-notif-origin-2b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 1);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
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
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.isNull(harness.continuationRequests[0]?.detail);

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

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000206",
            text: "The background subagent has finished.",
          }),
        );
        let bufferedYields = 0;
        yield* awaitUntil(() => bufferedYields++ >= 50, "subagent output to buffer");
        assert.lengthOf(harness.continuationRequests, 0);

        yield* Queue.offer(harness.sdkMessages, subagentNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.detail, SUBAGENT_SUMMARY);
        assert.equal(harness.continuationRequests[0]?.messageText, "Background task completed.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000204",
            result: "The subagent finished with SUB_SETTLE_DONE.",
          }),
        );
        const continuationRuntimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
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
            runtimePolicy: continuationRuntimePolicy,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.openedQueries, 1);

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

  it.effect("keeps Agent launch results off the root before aliases register", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const ackTaskId = "task-prealias-ack";
        const ackToolUseId = "toolu-prealias-ack";
        const resultTaskId = "task-prealias-result";
        const resultToolUseId = "toolu-prealias-result";
        const terminalText = "Terminal child result before alias registration.";
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
            attemptId: RunAttemptId.make("attempt-claude-prealias-launch-results"),
            text: "Delegate two tasks.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: ackToolUseId,
                  name: "Agent",
                  input: { prompt: "Keep running.", run_in_background: true },
                },
                {
                  type: "tool_use",
                  id: resultToolUseId,
                  name: "Agent",
                  input: { prompt: "Return a terminal result.", run_in_background: false },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: ackToolUseId,
                  content: [{ type: "text", text: "Async agent launched successfully." }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              isAsync: true,
              status: "async_launched",
              agentId: ackTaskId,
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: resultToolUseId,
                  content: [{ type: "text", text: terminalText }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000208",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: resultTaskId,
              content: [{ type: "text", text: terminalText }],
            },
          }),
        );
        for (const [taskId, uuid] of [
          [ackTaskId, "00000000-0000-4000-8000-000000000209"],
          [resultTaskId, "00000000-0000-4000-8000-000000000210"],
        ] as const) {
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskId,
              description: taskId,
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: taskId,
              uuid,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.nativeTaskRef?.nativeId === resultTaskId &&
                event.subagent.status === "completed",
            ),
          "pre-alias terminal result routed",
        );

        assert.equal(
          subagentEvents().findLast((event) => event.subagent.nativeTaskRef?.nativeId === ackTaskId)
            ?.subagent.status,
          "running",
        );
        assert.equal(
          subagentEvents().findLast(
            (event) => event.subagent.nativeTaskRef?.nativeId === resultTaskId,
          )?.subagent.result,
          terminalText,
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.threadId === harness.threadId &&
              (event.turnItem.nativeItemRef?.nativeId === ackToolUseId ||
                event.turnItem.nativeItemRef?.nativeId === resultToolUseId),
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000211",
            result: "Delegation launched.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("preserves Agent launch identity across a post-settlement result race", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-postsettle-prealias-result";
        const toolUseId = "toolu-postsettle-prealias-result";
        const siblingTaskId = "task-postsettle-prealias-sibling";
        const siblingToolUseId = "toolu-postsettle-prealias-sibling";
        const terminalText = "Distinct terminal result after the root settled.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-prealias-result-1"),
            text: "Delegate a task and settle.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: "Agent",
                  input: { prompt: "Finish after settle.", run_in_background: true },
                },
                {
                  type: "tool_use",
                  id: siblingToolUseId,
                  name: "Agent",
                  input: { prompt: "Remain running.", run_in_background: true },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000215",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        for (const [nativeTaskId, uuid] of [
          [taskId, "00000000-0000-4000-8000-000000000218"],
          [siblingTaskId, "00000000-0000-4000-8000-000000000221"],
        ] as const) {
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: nativeTaskId,
              description: "Post-settlement alias race",
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: nativeTaskId,
              uuid,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000216",
            result: "Root settled before the task alias arrived.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: [{ type: "text", text: terminalText }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000217",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: taskId,
              content: [{ type: "text", text: terminalText }],
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            status: "completed",
            output_file: "",
            summary: "Notification fallback after the terminal result.",
            uuid: "00000000-0000-4000-8000-000000000219",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation offer");
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-prealias-result-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === taskId,
            ),
          "post-settlement subagent replay",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000220",
            result: "Post-settlement task completed.",
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        const childThreadId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
        )?.subagent.childThreadId;
        assert.ok(childThreadId);
        assert.equal(
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.threadId === childThreadId &&
              event.turnItem.text === terminalText,
          ).length,
          1,
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.threadId === harness.threadId &&
              event.turnItem.nativeItemRef?.nativeId === toolUseId,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("keeps root tool results containing agentId on the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const toolUseId = "toolu-root-agent-id-output";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-root-agent-id-output"),
            text: "Run a root tool whose output includes an agentId field.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: "mcp__example__lookup",
                  input: { query: "external agent" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000226",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.nativeItemRef?.nativeId === toolUseId &&
                event.turnItem.threadId === harness.threadId &&
                event.turnItem.status === "running",
            ),
          "root tool started",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: [{ type: "text", text: "External lookup complete." }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000227",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: "external-service-agent",
              result: "External lookup complete.",
            },
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.nativeItemRef?.nativeId === toolUseId &&
                event.turnItem.threadId === harness.threadId &&
                event.turnItem.status === "completed",
            ),
          "root tool completed",
        );
        assert.isFalse(harness.events.some((event) => event.type === "subagent.updated"));

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000228",
            result: "Root tool result handled.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("forgets declined Agent approvals before missing-alias inference", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const harness = yield* makeWakeHarnessWithOptions({ runtimePolicy });
        const now = yield* DateTime.now;
        const declinedToolUseId = "toolu-declined-agent-launch";
        const launchToolUseId = "toolu-approved-agent-launch";
        const taskId = "task-approved-agent-launch";
        const childText = "Approved child output after a declined launch.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-declined-agent-launch"),
            text: "Decline one Agent launch, then approve another.",
            attachments: [],
            runtimePolicy,
          }),
        );
        yield* awaitUntil(() => harness.openedQueries.length === 1, "Claude query opened");
        const canUseTool = harness.openedQueries[0]?.options.canUseTool;
        assert.ok(canUseTool);
        if (canUseTool === undefined) {
          return;
        }

        const permissionFiber = yield* Effect.promise(() =>
          canUseTool(
            "Agent",
            { prompt: "This launch will be declined.", run_in_background: true },
            {
              requestId: "request-declined-agent-launch",
              signal: new AbortController().signal,
              toolUseID: declinedToolUseId,
            },
          ),
        ).pipe(Effect.forkScoped);
        yield* awaitUntil(
          () => harness.events.some((event) => event.type === "runtime_request.updated"),
          "Agent approval request",
        );
        const requestEvent = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
            event.type === "runtime_request.updated",
        );
        assert.ok(requestEvent);
        if (requestEvent === undefined) {
          return;
        }
        yield* harness.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "decline",
        });
        const declinedResult = yield* Fiber.join(permissionFiber);
        assert.equal(declinedResult?.behavior, "deny");

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: launchToolUseId,
                  name: "Agent",
                  input: { prompt: "This launch is valid.", run_in_background: true },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000235",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            description: "Approved Agent launch",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "This launch is valid.",
            uuid: "00000000-0000-4000-8000-000000000236",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === taskId,
            ),
          "approved subagent registered",
        );
        const childThreadId = harness.events.findLast(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
        )?.subagent.childThreadId;
        assert.ok(childThreadId);

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000237",
            text: childText,
            parentToolUseId: launchToolUseId,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.threadId === childThreadId &&
                event.turnItem.text === childText,
            ),
          "approved child output routed",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.threadId === harness.threadId &&
              event.turnItem.text === childText,
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000238",
            result: "Approval test complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("routes subagent permission artifacts by Claude agentID", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const harness = yield* makeWakeHarnessWithOptions({
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const taskId = "task-subagent-permission";
        const launchToolUseId = "toolu-subagent-permission-launch";
        const siblingTaskId = "task-subagent-permission-sibling";
        const siblingToolUseId = "toolu-subagent-permission-sibling";
        const childToolUseId = "toolu-subagent-permission-child";
        assert.isTrue(ClaudeProviderCapabilitiesV2.approvals.approvalsCanOriginateFromSubagents);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-subagent-permission"),
            text: "Delegate a task that needs permission.",
            attachments: [],
            runtimePolicy,
          }),
        );
        yield* awaitUntil(() => harness.openedQueries.length === 1, "Claude query opened");
        const canUseTool = harness.openedQueries[0]?.options.canUseTool;
        assert.ok(canUseTool);
        if (canUseTool === undefined) {
          return;
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: launchToolUseId,
                  name: "Agent",
                  input: { prompt: "Run a child command.", run_in_background: true },
                },
                {
                  type: "tool_use",
                  id: siblingToolUseId,
                  name: "Agent",
                  input: { prompt: "Remain idle.", run_in_background: true },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000212",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            description: "Child permission task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Run a child command.",
            uuid: "00000000-0000-4000-8000-000000000213",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: siblingTaskId,
            description: "Sibling permission task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Remain idle.",
            uuid: "00000000-0000-4000-8000-000000000223",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => harness.events.some((event) => event.type === "subagent.updated"),
          "subagent registered",
        );
        const childThreadId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId,
        )?.subagent.childThreadId;
        assert.ok(childThreadId);

        const controller = new AbortController();
        const permissionFiber = yield* Effect.promise(() =>
          canUseTool(
            "Bash",
            { command: "pwd" },
            {
              agentID: taskId,
              requestId: "request-subagent-permission",
              signal: controller.signal,
              toolUseID: childToolUseId,
            },
          ),
        ).pipe(Effect.forkScoped);
        yield* awaitUntil(
          () => harness.events.some((event) => event.type === "runtime_request.updated"),
          "child permission request",
        );
        const requestEvent = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
            event.type === "runtime_request.updated",
        );
        assert.ok(requestEvent);
        if (requestEvent === undefined) {
          return;
        }
        const approvalNode = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" && event.node.kind === "approval_request",
        )?.node;
        const approvalItem = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        )?.turnItem;
        const childToolNode = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" &&
            event.node.kind !== "approval_request" &&
            event.node.nativeItemRef?.nativeId === childToolUseId,
        )?.node;
        const childToolItem = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" &&
            event.turnItem.type !== "approval_request" &&
            event.turnItem.nativeItemRef?.nativeId === childToolUseId,
        )?.turnItem;
        assert.equal(approvalNode?.threadId, childThreadId);
        assert.isNull(approvalNode?.runId);
        assert.equal(approvalItem?.threadId, childThreadId);
        assert.isNull(approvalItem?.runId);
        assert.equal(childToolNode?.threadId, childThreadId);
        assert.isNull(childToolNode?.runId);
        assert.equal(approvalNode?.rootNodeId, childToolNode?.rootNodeId);
        assert.equal(approvalNode?.parentNodeId, childToolNode?.id);
        assert.equal(childToolNode?.parentNodeId, childToolNode?.rootNodeId);
        assert.isAbove(approvalItem?.ordinal ?? 0, childToolItem?.ordinal ?? 0);

        const concurrentRootText = "Root narration while child permission is pending.";
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000229",
            text: concurrentRootText,
            parentToolUseId: null,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "assistant_message" &&
                event.turnItem.threadId === harness.threadId &&
                event.turnItem.text === concurrentRootText,
            ),
          "SDK messages continue while permission is pending",
        );

        yield* harness.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "accept",
        });
        const permissionResult = yield* Fiber.join(permissionFiber);
        assert.equal(permissionResult?.behavior, "allow");
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: childToolUseId,
                  content: "Child command completed.",
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000222",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: taskId,
              stdout: "Child command completed.",
            },
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "node.updated" &&
                event.node.nativeItemRef?.nativeId === childToolUseId &&
                event.node.status === "completed",
            ),
          "child permission tool completed",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === childToolUseId &&
              event.node.threadId === harness.threadId,
          ),
        );

        const eventsBeforeUnknownRequest = harness.events.length;
        const unknownResult = yield* Effect.promise(() =>
          canUseTool(
            "Bash",
            { command: "pwd" },
            {
              agentID: "task-unknown-permission",
              requestId: "request-unknown-permission",
              signal: new AbortController().signal,
              toolUseID: "toolu-unknown-permission",
            },
          ),
        );
        assert.equal(unknownResult?.behavior, "deny");
        assert.lengthOf(harness.events, eventsBeforeUnknownRequest);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000214",
            result: "Delegation paused for permission.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("routes interleaved post-settlement subagent output through durable aliases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstTaskId = "task-postsettle-first";
        const firstToolUseId = "toolu-postsettle-first";
        const secondTaskId = "task-postsettle-second";
        const secondToolUseId = "toolu-postsettle-second";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );
        const toolItems = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
              event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
          );
        const taskStarted = (taskId: string, toolUseId: string, uuid: string) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: toolUseId,
            description: `Run ${taskId}`,
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: `Complete ${taskId}.`,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const childToolUse = (parentToolUseId: string, toolUseId: string, uuid: string) =>
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: toolUseId, name: "ChildTool", input: {} }],
            },
            parent_tool_use_id: parentToolUseId,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const childToolResult = (parentToolUseId: string, toolUseId: string, uuid: string) =>
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
            },
            parent_tool_use_id: parentToolUseId,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        const taskNotification = (input: {
          readonly taskId: string;
          readonly summary: string;
          readonly uuid: string;
          readonly toolUseId?: string;
        }) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: input.taskId,
            ...(input.toolUseId === undefined ? {} : { tool_use_id: input.toolUseId }),
            status: "completed",
            output_file: "",
            summary: input.summary,
            uuid: input.uuid,
            session_id: WAKE_NATIVE_SESSION,
          });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-1"),
            text: "Launch two background subagents.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          taskStarted(firstTaskId, firstToolUseId, "00000000-0000-4000-8000-000000000601"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          taskStarted(secondTaskId, secondToolUseId, "00000000-0000-4000-8000-000000000602"),
        );
        yield* awaitUntil(() => subagentEvents().length >= 2, "two subagent nodes");
        const firstChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId,
        )?.subagent.childThreadId;
        const secondChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === secondTaskId,
        )?.subagent.childThreadId;
        assert.ok(firstChildThreadId);
        assert.ok(secondChildThreadId);
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000603",
            text: "Root launch complete.",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000604",
            result: "Root launch complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "launch turn terminal");

        const firstNarration = "First child narration.";
        const firstFinal = "First child SDK final.";
        const firstSummary = "First child distinct terminal summary.";
        const secondNarration = "Second child narration.";
        const secondFinal = "Second child final.";
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000605",
            text: firstNarration,
            parentToolUseId: firstToolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000606",
            text: secondNarration,
            parentToolUseId: secondToolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          childToolUse(
            firstToolUseId,
            "toolu-postsettle-first-read",
            "00000000-0000-4000-8000-000000000607",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          childToolUse(
            secondToolUseId,
            "toolu-postsettle-second-read",
            "00000000-0000-4000-8000-000000000608",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          childToolResult(
            firstToolUseId,
            "toolu-postsettle-first-read",
            "00000000-0000-4000-8000-000000000609",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          childToolResult(
            secondToolUseId,
            "toolu-postsettle-second-read",
            "00000000-0000-4000-8000-000000000610",
          ),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000611",
            text: firstFinal,
            parentToolUseId: firstToolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000612",
            text: secondFinal,
            parentToolUseId: secondToolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          taskNotification({
            taskId: firstTaskId,
            summary: firstSummary,
            uuid: "00000000-0000-4000-8000-000000000613",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          taskNotification({
            taskId: secondTaskId,
            toolUseId: secondToolUseId,
            summary: secondFinal,
            uuid: "00000000-0000-4000-8000-000000000614",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000615",
            result: "Root processed both completions.",
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        const firstChildAssistantTexts = assistantItems()
          .filter((item) => item.threadId === firstChildThreadId)
          .map((item) => item.text);
        const secondChildAssistantTexts = assistantItems()
          .filter((item) => item.threadId === secondChildThreadId)
          .map((item) => item.text);
        assert.deepEqual(firstChildAssistantTexts, [firstNarration, firstFinal, firstSummary]);
        assert.deepEqual(secondChildAssistantTexts, [secondNarration, secondFinal]);
        assert.deepEqual(
          toolItems().map((event) => event.turnItem.threadId),
          [firstChildThreadId, secondChildThreadId, firstChildThreadId, secondChildThreadId],
        );
        const rootAssistantTexts = assistantItems()
          .filter((item) => item.threadId === harness.threadId)
          .map((item) => item.text);
        assert.deepEqual(rootAssistantTexts, [
          "Root launch complete.",
          "Root processed both completions.",
        ]);
        for (const childText of [
          firstNarration,
          firstFinal,
          firstSummary,
          secondNarration,
          secondFinal,
        ]) {
          assert.notInclude(rootAssistantTexts, childText);
        }
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("buffers a short subagent registration race without leaking to the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-registration-race";
        const toolUseId = "toolu-registration-race";
        const childText = "Child text that arrived before registration.";
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );
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
            attemptId: RunAttemptId.make("attempt-claude-registration-race"),
            text: "Delegate after the child begins responding.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000621",
            text: childText,
            parentToolUseId: toolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            description: "Registration race",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Finish after registration.",
            uuid: "00000000-0000-4000-8000-000000000622",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => subagentEvents().length === 1, "subagent registered without alias");
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: toolUseId,
            description: "Registration race",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Finish after registration.",
            uuid: "00000000-0000-4000-8000-000000000624",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => assistantItems().some((item) => item.text === childText),
          "buffered child text",
        );
        const childThreadId = subagentEvents().at(-1)?.subagent.childThreadId;
        assert.ok(childThreadId);
        assert.equal(
          assistantItems().find((item) => item.text === childText)?.threadId,
          childThreadId,
        );
        assert.isFalse(
          assistantItems().some(
            (item) => item.threadId === harness.threadId && item.text === childText,
          ),
        );

        const terminalText = "Terminal result after the late launch alias.";
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: [{ type: "text", text: terminalText }],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000625",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: taskId,
              content: [{ type: "text", text: terminalText }],
            },
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.status === "completed" && event.subagent.result === terminalText,
            ),
          "late launch alias terminal result",
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000623",
            result: "Root race handling complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "race turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("waits for explicit aliases when sibling task starts are ambiguous", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstTaskId = "task-ambiguous-first";
        const firstToolUseId = "toolu-ambiguous-first";
        const firstChildText = "First ambiguous child text.";
        const secondTaskId = "task-ambiguous-second";
        const secondToolUseId = "toolu-ambiguous-second";
        const secondChildText = "Second ambiguous child text.";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-ambiguous-launch-alias"),
            text: "Delegate two tasks.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: firstToolUseId,
                  name: "Agent",
                  input: { prompt: "Return the first child result.", run_in_background: true },
                },
                {
                  type: "tool_use",
                  id: secondToolUseId,
                  name: "Agent",
                  input: { prompt: "Return the second child result.", run_in_background: true },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000639",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000640",
            text: secondChildText,
            parentToolUseId: secondToolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000641",
            text: firstChildText,
            parentToolUseId: firstToolUseId,
          }),
        );
        for (const [taskId, description, uuid] of [
          [secondTaskId, "Second task starts first", "00000000-0000-4000-8000-000000000642"],
          [firstTaskId, "First task starts second", "00000000-0000-4000-8000-000000000643"],
        ] as const) {
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskId,
              description,
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: description,
              uuid,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* awaitUntil(() => subagentEvents().length === 2, "ambiguous sibling registrations");
        assert.notIncludeMembers(
          assistantItems().map((item) => item.text),
          [firstChildText, secondChildText],
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: firstTaskId,
            tool_use_id: firstToolUseId,
            description: "Explicit progress alias available",
            uuid: "00000000-0000-4000-8000-000000000644",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: secondTaskId,
            tool_use_id: secondToolUseId,
            status: "completed",
            output_file: "",
            summary: "Second child notification fallback.",
            uuid: "00000000-0000-4000-8000-000000000645",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            assistantItems().some((item) => item.text === firstChildText) &&
            assistantItems().some((item) => item.text === secondChildText),
          "ambiguous sibling buffers drained",
        );

        const firstChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId,
        )?.subagent.childThreadId;
        const secondChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === secondTaskId,
        )?.subagent.childThreadId;
        assert.ok(firstChildThreadId);
        assert.ok(secondChildThreadId);
        assert.equal(
          assistantItems().find((item) => item.text === firstChildText)?.threadId,
          firstChildThreadId,
        );
        assert.equal(
          assistantItems().find((item) => item.text === secondChildText)?.threadId,
          secondChildThreadId,
        );
        assert.isFalse(
          assistantItems().some(
            (item) =>
              item.threadId === harness.threadId &&
              (item.text === firstChildText || item.text === secondChildText),
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: firstToolUseId,
                  content: "First child terminal result.",
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000646",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.nativeTaskRef?.nativeId === firstTaskId &&
                event.subagent.status === "completed",
            ),
          "late launch alias terminal result",
        );
        assert.equal(
          subagentEvents().findLast(
            (event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId,
          )?.subagent.result,
          "First child terminal result.",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.threadId === harness.threadId &&
              event.turnItem.nativeItemRef?.nativeId === firstToolUseId,
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: secondToolUseId,
                  content: "Second child terminal result.",
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000647",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.nativeTaskRef?.nativeId === secondTaskId &&
                event.subagent.result === "Second child terminal result.",
            ),
          "notification alias terminal result",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.threadId === harness.threadId &&
              event.turnItem.nativeItemRef?.nativeId === secondToolUseId,
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000648",
            result: "Root delegation complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("disables implicit launch aliases after pending launch overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const launches = Array.from({ length: 33 }, (_, index) => ({
          taskId: `task-launch-overflow-${index + 1}`,
          toolUseId: `toolu-launch-overflow-${index + 1}`,
        }));
        const finalLaunch = launches.at(-1)!;
        const childText = "Only the final explicit overflow alias may receive this text.";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-launch-overflow"),
            text: "Delegate more tasks than implicit alias recovery can retain.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: launches.map((launch) => ({
                type: "tool_use" as const,
                id: launch.toolUseId,
                name: "Agent",
                input: { prompt: launch.taskId, run_in_background: true },
              })),
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000720",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000721",
            text: childText,
            parentToolUseId: finalLaunch.toolUseId,
          }),
        );
        for (const [index, launch] of launches.slice(1, -1).entries()) {
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: launch.taskId,
              tool_use_id: launch.toolUseId,
              description: launch.taskId,
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: launch.taskId,
              uuid: `00000000-0000-4000-8000-${String(722 + index).padStart(12, "0")}`,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: launches[0]!.taskId,
            description: "Evicted launch starts without an alias",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: launches[0]!.taskId,
            uuid: "00000000-0000-4000-8000-000000000753",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) => event.subagent.nativeTaskRef?.nativeId === launches[0]!.taskId,
            ),
          "alias-free overflow task registration",
        );
        assert.notInclude(
          assistantItems().map((item) => item.text),
          childText,
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: finalLaunch.taskId,
            tool_use_id: finalLaunch.toolUseId,
            description: "Final launch receives its explicit alias",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: finalLaunch.taskId,
            uuid: "00000000-0000-4000-8000-000000000754",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => assistantItems().some((item) => item.text === childText),
          "explicit overflow alias buffer drain",
        );

        const evictedChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === launches[0]!.taskId,
        )?.subagent.childThreadId;
        const finalChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === finalLaunch.taskId,
        )?.subagent.childThreadId;
        assert.ok(evictedChildThreadId);
        assert.ok(finalChildThreadId);
        assert.equal(
          assistantItems().find((item) => item.text === childText)?.threadId,
          finalChildThreadId,
        );
        assert.notEqual(finalChildThreadId, evictedChildThreadId);
        assert.isFalse(
          assistantItems().some(
            (item) => item.threadId === harness.threadId && item.text === childText,
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000755",
            result: "Overflow routing complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "overflow turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("extracts text from direct content-block subagent results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-direct-content-blocks";
        const SUBAGENT_TOOL_USE_ID = "toolu-direct-content-blocks";
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
            attemptId: RunAttemptId.make("attempt-claude-direct-content-blocks"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Delegated task",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the result.",
            uuid: "00000000-0000-4000-8000-000000000206",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => subagentEvents().length === 1, "subagent node created");

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: SUBAGENT_TOOL_USE_ID,
                  content: [
                    { type: "text", text: "First line." },
                    { type: "text", text: "Second line." },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000207",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => subagentEvents().at(-1)?.subagent.status === "completed",
          "subagent terminal",
        );

        assert.equal(subagentEvents().at(-1)?.subagent.result, "First line.\nSecond line.");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000208",
            result: "Delegation completed.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("gives batched sibling subagent results distinct native identities", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstTaskId = "task-batched-result-first";
        const firstToolUseId = "toolu-batched-result-first";
        const secondTaskId = "task-batched-result-second";
        const secondToolUseId = "toolu-batched-result-second";
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
            attemptId: RunAttemptId.make("attempt-claude-batched-sibling-results"),
            text: "Delegate two tasks.",
            attachments: [],
          }),
        );
        for (const [taskId, toolUseId, uuid] of [
          [firstTaskId, firstToolUseId, "00000000-0000-4000-8000-000000000631"],
          [secondTaskId, secondToolUseId, "00000000-0000-4000-8000-000000000632"],
        ] as const) {
          yield* Queue.offer(
            harness.sdkMessages,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskId,
              tool_use_id: toolUseId,
              description: `Run ${taskId}`,
              subagent_type: "general-purpose",
              task_type: "local_agent",
              prompt: `Complete ${taskId}.`,
              uuid,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* awaitUntil(() => subagentEvents().length >= 2, "two sibling subagents");
        const firstChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId,
        )?.subagent.childThreadId;
        const secondChildThreadId = subagentEvents().find(
          (event) => event.subagent.nativeTaskRef?.nativeId === secondTaskId,
        )?.subagent.childThreadId;
        assert.ok(firstChildThreadId);
        assert.ok(secondChildThreadId);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: firstToolUseId,
                  content: "First sibling result.",
                },
                {
                  type: "tool_result",
                  tool_use_id: secondToolUseId,
                  content: "Second sibling result.",
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000633",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().filter((event) => event.subagent.status === "completed").length >= 2,
          "two sibling results",
        );

        const childMessages = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated" &&
            (event.message.threadId === firstChildThreadId ||
              event.message.threadId === secondChildThreadId) &&
            (event.message.text === "First sibling result." ||
              event.message.text === "Second sibling result."),
        );
        assert.deepEqual(
          childMessages.map((event) => [event.message.threadId, event.message.text]),
          [
            [firstChildThreadId, "First sibling result."],
            [secondChildThreadId, "Second sibling result."],
          ],
        );
        assert.notEqual(childMessages[0]?.message.id, childMessages[1]?.message.id);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000634",
            result: "Both delegated tasks completed.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("buffers batched pre-alias Agent results by their own lineage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const firstTaskId = "task-batched-prealias-first";
        const firstToolUseId = "toolu-batched-prealias-first";
        const secondTaskId = "task-batched-prealias-second";
        const secondToolUseId = "toolu-batched-prealias-second";
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
            attemptId: RunAttemptId.make("attempt-claude-batched-prealias-results"),
            text: "Delegate two tasks before their aliases arrive.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: firstToolUseId,
                  name: "Agent",
                  input: { prompt: "Return the first result.", run_in_background: false },
                },
                {
                  type: "tool_use",
                  id: secondToolUseId,
                  name: "Agent",
                  input: { prompt: "Return the second result.", run_in_background: false },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000701",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: firstToolUseId,
                  content: "First pre-alias result.",
                },
                {
                  type: "tool_result",
                  tool_use_id: secondToolUseId,
                  content: "Second pre-alias result.",
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000702",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              agentId: "task-shared-batched-output",
              content: [{ type: "text", text: "Shared structured result." }],
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: secondTaskId,
            tool_use_id: secondToolUseId,
            description: "Second task starts first",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the second result.",
            uuid: "00000000-0000-4000-8000-000000000703",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.nativeTaskRef?.nativeId === secondTaskId &&
                event.subagent.status === "completed",
            ),
          "second batched pre-alias result",
        );
        assert.equal(
          subagentEvents().findLast(
            (event) => event.subagent.nativeTaskRef?.nativeId === secondTaskId,
          )?.subagent.result,
          "Second pre-alias result.",
        );
        assert.isFalse(
          subagentEvents().some((event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: firstTaskId,
            tool_use_id: firstToolUseId,
            description: "First task starts second",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the first result.",
            uuid: "00000000-0000-4000-8000-000000000704",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            subagentEvents().some(
              (event) =>
                event.subagent.nativeTaskRef?.nativeId === firstTaskId &&
                event.subagent.status === "completed",
            ),
          "first batched pre-alias result",
        );
        assert.equal(
          subagentEvents().findLast(
            (event) => event.subagent.nativeTaskRef?.nativeId === firstTaskId,
          )?.subagent.result,
          "First pre-alias result.",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.threadId === harness.threadId &&
              (event.turnItem.nativeItemRef?.nativeId === firstToolUseId ||
                event.turnItem.nativeItemRef?.nativeId === secondToolUseId),
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000705",
            result: "Both pre-alias tasks completed.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
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
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
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
        const childThreadId = subagentEvents()[0]!.subagent.childThreadId;
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
        // A duplicate terminal frame from the completed generation must not
        // close the resumed generation before its new output arrives.
        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            text: "Original launch alias still routes.",
            uuid: "00000000-0000-4000-8000-000000000413",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            parentToolUseId: RESUME_TOOL_USE_ID,
            text: SECOND_SUMMARY,
            uuid: "00000000-0000-4000-8000-000000000414",
          }),
        );
        yield* awaitUntil(
          () =>
            assistantItems().some(
              (item) => item.threadId === childThreadId && item.text === SECOND_SUMMARY,
            ),
          "resumed child text routed through both aliases",
        );
        assert.equal(subagentEvents().at(-1)?.subagent.status, "running");
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
        const childTexts = assistantItems()
          .filter((item) => item.threadId === childThreadId)
          .map((item) => item.text);
        assert.equal(
          childTexts.filter((text) => text === "Original launch alias still routes.").length,
          1,
        );
        assert.equal(childTexts.filter((text) => text === SECOND_SUMMARY).length, 1);
        const rootTexts = assistantItems()
          .filter((item) => item.threadId === harness.threadId)
          .map((item) => item.text);
        assert.notInclude(rootTexts, "Original launch alias still routes.");
        assert.notInclude(rootTexts, SECOND_SUMMARY);

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

  it.effect(
    "orders nonempty level, empty level, notification, and continuation drain without subagent projection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const nonemptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [
              {
                task_id: WAKE_TASK_ID,
                description: "npm run build",
                task_type: "local_bash",
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000600",
            session_id: WAKE_NATIVE_SESSION,
          });
          const emptyRoster = claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000601",
            session_id: WAKE_NATIVE_SESSION,
          });
          const duplicateNotification = claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: WAKE_TASK_ID,
            status: "completed",
            output_file: "/tmp/task-wake-build-dup.log",
            summary: "duplicate should not re-buffer",
            uuid: "00000000-0000-4000-8000-000000000605",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-level-before-edge-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          // 1) Nonempty authoritative level admits local_bash to Waiting +
          // wake eligibility.
          yield* Queue.offer(harness.sdkMessages, nonemptyRoster);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(harness.events).some(
                (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
              ),
            "nonempty level populated Waiting roster",
          );
          assert.deepEqual(
            providerThreadRosterEvents(harness.events).at(-1)?.providerThread
              .pendingBackgroundTasks ?? [],
            [
              {
                taskId: WAKE_TASK_ID,
                description: "npm run build",
                taskType: "local_bash",
              },
            ],
          );
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);

          // 2) Empty level clears Waiting but keeps wake eligibility so the
          // later notification can still offer exactly one continuation.
          yield* Queue.offer(harness.sdkMessages, emptyRoster);
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(harness.events).some(
                (event) =>
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "empty level cleared Waiting roster",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.continuationRequests, 0);

          // 3) First idle notification buffers and consumes eligibility. The
          // following native assistant frame proves Claude began a wake turn.
          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          yield* Queue.offer(harness.sdkMessages, wakeAssistant);
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation after level-before-edge",
          );
          assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

          // A duplicate notification must not re-buffer or re-offer.
          yield* Queue.offer(harness.sdkMessages, duplicateNotification);
          let settleYields = 0;
          yield* awaitUntil(() => settleYields++ >= 50, "duplicate notification settle");
          assert.lengthOf(harness.continuationRequests, 1);

          // 4) Continuation drain classifies the buffered notification as
          // local_bash (replay tombstone) and never fabricates a subagent.
          yield* Queue.offer(harness.sdkMessages, wakeResult);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-level-before-edge-b"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
          assert.equal(harness.terminalEvents()[1]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 1);
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === WAKE_ASSISTANT_TEXT,
            ),
          );
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" ||
                (event.type === "node.updated" && event.node.kind === "subagent"),
            ),
          );
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type !== "provider_thread.updated" &&
                JSON.stringify(event).includes(WAKE_TASK_ID),
            ),
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect("resets Waiting roster and wake eligibility when the CLI process is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-process-reset-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapterV2Event> = [];
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
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  // End this process stream so openQuery can replace it.
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-process-reset");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-process-reset"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        assert.equal(processQueues.length, 1);
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(firstProcess, wakeTaskStarted);
        yield* Queue.offer(firstProcess, turnOneResult);
        yield* awaitUntil(
          () => events.some((event) => event.type === "turn.terminal"),
          "first turn terminal",
        );
        assert.isTrue(yield* hasPendingBackgroundWork);

        const alternateModel = {
          ...CLAUDE_TEST_MODEL_SELECTION,
          model: "claude-haiku-4-5-20251001",
        } satisfies ModelSelection;
        // ProviderTurnStartService marks the thread active before startTurn;
        // the process-reset clear must preserve that status.
        const activeProviderThread = {
          ...providerThread,
          status: "active" as const,
        } satisfies OrchestrationV2ProviderThread;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: activeProviderThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-b"),
            text: "Continue after process restart.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: alternateModel,
          }),
        );
        assert.equal(processQueues.length, 2);

        // Process-scoped level resets to empty on CLI (re)start while the
        // starting turn's provider thread remains active (not idle).
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.status === "active" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
                // Prefer the post-replace clear over the initial empty thread.
                event.providerThread.updatedAt !== undefined,
            ),
          "roster cleared on process replace while remaining active",
        );
        // After replace, the in-memory Waiting probe must be false even if a
        // late empty-level event was already present before background work.
        assert.isFalse(yield* hasPendingBackgroundWork);
        const emptyActiveRosterEvents = providerThreadRosterEvents(events).filter(
          (event) =>
            event.providerThread.status === "active" &&
            (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isAtLeast(emptyActiveRosterEvents.length, 1);
        assert.deepEqual(
          emptyActiveRosterEvents.at(-1)?.providerThread.pendingBackgroundTasks ?? [],
          [],
        );
        assert.equal(emptyActiveRosterEvents.at(-1)?.providerThread.status, "active");

        // A late notification from the previous process must not wake after
        // eligibility was reset with the process. Offer on the new process
        // stream (the old queue is shut down).
        const secondProcess = processQueues[1]!;
        yield* Queue.offer(secondProcess, wakeNotification);
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "stale notification settle");
        assert.lengthOf(continuationRequests, 0);

        yield* Queue.offer(
          secondProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000602",
            result: "Process restart turn finished.",
          }),
        );
        yield* awaitUntil(
          () => events.filter((event) => event.type === "turn.terminal").length === 2,
          "second turn terminal",
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("admits only local_bash from a mixed background_tasks_changed snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const SUBAGENT_TASK_ID = "task-mixed-snapshot-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-mixed-snapshot-subagent";
        const mixedSnapshot = claudeSdkFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: WAKE_TASK_ID,
              description: "npm run build",
              task_type: "local_bash",
            },
            {
              task_id: SUBAGENT_TASK_ID,
              description: "Agent review",
              task_type: "local_agent",
            },
            {
              task_id: "task-mixed-foreground-agent",
              description: "Backgrounded foreground agent",
              task_type: "local_agent",
            },
          ],
          uuid: "00000000-0000-4000-8000-000000000603",
          session_id: WAKE_NATIVE_SESSION,
        });
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Agent review",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Review the change.",
          uuid: "00000000-0000-4000-8000-000000000604",
          session_id: WAKE_NATIVE_SESSION,
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-mixed-snapshot"),
            text: "Background a bash task and a subagent.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.nativeTaskRef?.nativeId === SUBAGENT_TASK_ID,
            ),
          "subagent projected normally",
        );
        yield* Queue.offer(harness.sdkMessages, mixedSnapshot);
        yield* awaitUntil(
          () =>
            providerThreadRosterEvents(harness.events).some(
              (event) => (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          "roster after mixed snapshot",
        );

        const roster = providerThreadRosterEvents(harness.events).at(-1)?.providerThread
          .pendingBackgroundTasks;
        assert.deepEqual(roster ?? [], [
          {
            taskId: WAKE_TASK_ID,
            description: "npm run build",
            taskType: "local_bash",
          },
        ]);
        // Subagent lifecycle stays on the subagent path, not the Waiting roster.
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === SUBAGENT_TASK_ID &&
              event.subagent.status === "running",
          ),
        );
        assert.isFalse((roster ?? []).some((task) => task.taskId === SUBAGENT_TASK_ID));

        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn terminal");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect(
    "preserves buffered local_bash notification classification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-buffer-replace-",
          });
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapterV2Event> = [];
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
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-buffer-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, wakeTaskStarted);
          yield* Queue.offer(firstProcess, turnOneResult);
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);

          // Idle completion notification buffers before any continuation runs.
          yield* Queue.offer(firstProcess, wakeNotification);
          let quietYields = 0;
          yield* awaitUntil(() => quietYields++ >= 50, "notification-only quiet window");
          assert.lengthOf(continuationRequests, 0);

          // User turn changes model, replacing the query while the wake buffer
          // stays queued for the later provider continuation.
          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-user"),
              text: "Switch model while background work completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000701",
              result: "User turn finished after model switch.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "user turn terminal after replace",
          );
          // The terminal notification remains buffered for classification, but
          // notification-only traffic no longer pins pending work.
          assert.isFalse(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 0);

          // Continuation drains the buffered local_bash notification with no
          // fabricated subagent/node and attributes the wake result text.
          yield* Queue.offer(secondProcess, wakeResult);
          yield* awaitUntil(() => continuationRequests.length === 1, "continuation after result");
          assert.equal(continuationRequests[0]?.detail, WAKE_SUMMARY);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
            "continuation terminal after buffered drain",
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "subagent.updated" ||
                (event.type === "node.updated" && event.node.kind === "subagent"),
            ),
          );
          // Must not re-project the opaque task id as anything but roster history.
          assert.isFalse(
            events.some(
              (event) =>
                event.type !== "provider_thread.updated" &&
                JSON.stringify(event).includes(WAKE_TASK_ID),
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect(
    "does not opaque-misclassify a buffered subagent notification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const SUBAGENT_TASK_ID = "task-buffer-replace-subagent";
          const SUBAGENT_TOOL_USE_ID = "toolu-buffer-replace-subagent";
          const SUBAGENT_SUMMARY = "SUB_BUFFER_REPLACE_DONE";
          const subagentTaskStarted = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research then return SUB_BUFFER_REPLACE_DONE.",
            uuid: "00000000-0000-4000-8000-000000000801",
            session_id: WAKE_NATIVE_SESSION,
          });
          const subagentNotification = claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            status: "completed",
            output_file: "/tmp/task-buffer-replace-subagent.output",
            summary: SUBAGENT_SUMMARY,
            uuid: "00000000-0000-4000-8000-000000000802",
            session_id: WAKE_NATIVE_SESSION,
          });
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
            uuid: "00000000-0000-4000-8000-000000000803",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              isAsync: true,
              status: "async_launched",
              agentId: SUBAGENT_TASK_ID,
              prompt: "Research then return SUB_BUFFER_REPLACE_DONE.",
            },
          });

          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-subagent-buffer-replace-",
          });
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapterV2Event> = [];
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
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-subagent-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-claude-subagent-buffer-replace",
            ),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const subagentEvents = () =>
            events.filter(
              (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
                event.type === "subagent.updated",
            );
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-a"),
              text: "Spawn a background subagent and stop.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, subagentTaskStarted);
          yield* awaitUntil(() => subagentEvents().length >= 1, "subagent node created");
          assert.equal(subagentEvents()[0]?.subagent.status, "running");
          yield* Queue.offer(firstProcess, subagentAsyncAck);
          yield* Queue.offer(
            firstProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000804",
              result: "Spawned the subagent in the background.",
            }),
          );
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);

          // Session-registered subagent completion buffers; no opaque tombstone.
          yield* Queue.offer(firstProcess, subagentNotification);
          yield* awaitUntil(() => continuationRequests.length === 1, "continuation after notify");
          assert.equal(continuationRequests[0]?.detail, SUBAGENT_SUMMARY);

          // Model-changing user turn replaces the query while continuation stays
          // queued. Process reset must not invent opaque classification for the
          // buffered subagent notification.
          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-user"),
              text: "Switch model while the subagent completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000805",
              result: "User turn finished after model switch.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "user turn terminal after replace",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 1);

          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000806",
              result: "The subagent finished with SUB_BUFFER_REPLACE_DONE.",
            }),
          );
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-subagent-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
            "continuation terminal after buffered subagent drain",
          );

          const finalSubagent = subagentEvents().at(-1)?.subagent;
          assert.equal(finalSubagent?.status, "completed");
          assert.equal(finalSubagent?.result, SUBAGENT_SUMMARY);
          assert.equal(finalSubagent?.runId, subagentEvents()[0]?.subagent.runId);
          const subagentNodeEvents = events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          );
          assert.equal(subagentNodeEvents.at(-1)?.node.status, "completed");
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect(
    "clears process-scoped roster when same-native-thread replacement open fails after close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapterV2Event> = [];
          const adapter = makeClaudeAdapterV2({
            instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            idAllocator,
            continuationRequests: {
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
              open: () => {
                openCount += 1;
                if (openCount === 2) {
                  return Effect.fail(
                    new ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "forced replacement open failure",
                    }),
                  );
                }
                return Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                });
              },
              forkSession: () => Effect.die("unused forkSession"),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-replace-open-fail");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-replace-open-fail"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* awaitUntil(
            () => events.some((event) => event.type === "turn.terminal"),
            "first turn terminal",
          );
          assert.isTrue(yield* hasPendingBackgroundWork);

          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          const failedStart = yield* runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread: { ...providerThread, status: "active" },
                now,
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          // Old process was closed before the failed open: roster must not stick.
          yield* awaitUntil(
            () =>
              providerThreadRosterEvents(events).some(
                (event) =>
                  event.providerThread.status === "idle" &&
                  (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
              ),
            "roster cleared after failed same-thread replacement open",
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect(
    "preserves buffered wake and continuation state when same-native-thread replacement open fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-replace-open-fail-wake-",
          });
          let openCount = 0;
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapterV2Event> = [];
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
              open: () => {
                openCount += 1;
                if (openCount === 2) {
                  return Effect.fail(
                    new ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "forced replacement open failure",
                    }),
                  );
                }
                return Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                });
              },
              forkSession: () => Effect.die("unused forkSession"),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-replace-open-fail-wake");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(
              "provider-session-claude-replace-open-fail-wake",
            ),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(processQueues[0]!, wakeTaskStarted);
          yield* Queue.offer(processQueues[0]!, turnOneResult);
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 1,
            "first turn terminal",
          );
          yield* Queue.offer(processQueues[0]!, wakeNotification);
          yield* Queue.offer(processQueues[0]!, wakeAssistant);
          yield* awaitUntil(() => continuationRequests.length === 1, "first continuation request");
          assert.isTrue(yield* hasPendingBackgroundWork);

          const alternateModel = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            model: "claude-haiku-4-5-20251001",
          } satisfies ModelSelection;
          const failedStart = yield* runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId,
                providerThread: { ...providerThread, status: "active" },
                now,
                attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-b"),
                text: "Replace process but fail open.",
                attachments: [],
                providerTurnOrdinal: 2,
                modelSelection: alternateModel,
              }),
            )
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failedStart));
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 1);

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-c"),
              text: "Retry after the failed replacement.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          const retryProcess = processQueues[1]!;
          const retryTaskId = "task-wake-build-after-retry";
          yield* Queue.offer(
            retryProcess,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: retryTaskId,
              description: "npm run build after retry",
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000901",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            retryProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000902",
              result: "Kicked off the retry build in the background.",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
            "retry turn terminal",
          );

          // The already-requested continuation survives the failed process
          // replacement and drains the wake output after the user retry.
          yield* Queue.offer(retryProcess, wakeResult);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-replace-open-fail-wake-d"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
            "preserved continuation terminal",
          );
          assert.lengthOf(continuationRequests, 1);

          yield* Queue.offer(
            retryProcess,
            claudeSdkFrame({
              type: "system",
              subtype: "task_notification",
              task_id: retryTaskId,
              status: "completed",
              output_file: "/tmp/task-wake-build-after-retry.log",
              summary: "Retry build completed successfully",
              uuid: "00000000-0000-4000-8000-000000000903",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* Queue.offer(
            retryProcess,
            claudeSdkFrame({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "The retry build has finished." }],
              },
              parent_tool_use_id: null,
              uuid: "00000000-0000-4000-8000-000000000904",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* awaitUntil(
            () => continuationRequests.length === 2,
            "continuation request after retry",
          );
          assert.equal(continuationRequests[1]?.detail, "Retry build completed successfully");
        }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
      ),
  );

  it.effect("does not invent process reset state on a first-ever failed open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-first-open-fail-",
        });
        const events: Array<ProviderAdapterV2Event> = [];
        const adapter = makeClaudeAdapterV2({
          instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          idAllocator,
          continuationRequests: {
            offer: () => Effect.void,
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.fail(
                new ClaudeAgentSdkQueryRunnerError({
                  method: "open",
                  cause: "forced first open failure",
                }),
              ),
            forkSession: () => Effect.die("unused forkSession"),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-first-open-fail");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-first-open-fail"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;
        const failedStart = yield* runtime
          .startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-first-open-fail"),
              text: "First open fails.",
              attachments: [],
            }),
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failedStart));
        // No live process ever existed: do not emit a fabricated empty roster.
        assert.lengthOf(providerThreadRosterEvents(events), 0);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );
  it.effect("releases pending work after a failed wake dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const siblingTaskId = "task-failed-wake-sibling";
        const failedToolUseId = "toolu-failed-wake-child-tool";
        const failedToolItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === failedToolUseId
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-failed-wake-dispatch"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: WAKE_TASK_ID,
            tool_use_id: "toolu-failed-wake-child",
            description: "Background subagent",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Finish after the parent settles.",
            uuid: "00000000-0000-4000-8000-000000000631",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: failedToolUseId,
                  name: "Bash",
                  input: { command: "printf unfinished" },
                },
              ],
            },
            parent_tool_use_id: "toolu-failed-wake-child",
            uuid: "00000000-0000-4000-8000-000000000630",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => failedToolItems().at(-1)?.status === "running",
          "failed-wake child tool started",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: siblingTaskId,
            tool_use_id: "toolu-failed-wake-sibling",
            description: "Still-running sibling",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Finish after the first sibling's wake fails.",
            uuid: "00000000-0000-4000-8000-000000000632",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation offer");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        const request = harness.continuationRequests[0];
        assert.isDefined(request?.dispatchIfCurrent);
        let dispatchAttempts = 0;
        const dispatch = Effect.sync(() => {
          dispatchAttempts += 1;
        }).pipe(Effect.andThen(Effect.fail("dispatch failure")));
        const exit = yield* Effect.exit(request!.dispatchIfCurrent!(dispatch));
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(dispatchAttempts, 1);
        yield* request!.failIfCurrent!(Cause.fail("dispatch failure"));
        yield* awaitUntil(
          () =>
            harness.events.findLast((event) => event.type === "subagent.updated")?.subagent
              .status === "failed",
          "failed subagent projection",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: siblingTaskId,
            status: "completed",
            output_file: "/tmp/task-failed-wake-sibling.output",
            summary: "The sibling completed after the failed wake.",
            uuid: "00000000-0000-4000-8000-000000000633",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );

        const failedSubagent = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === WAKE_TASK_ID,
        );
        assert.equal(failedSubagent?.type, "subagent.updated");
        assert.equal(
          failedSubagent?.type === "subagent.updated" ? failedSubagent.subagent.status : null,
          "failed",
        );
        assert.equal(
          failedSubagent?.type === "subagent.updated" ? failedSubagent.subagent.result : null,
          "Background task completion could not be delivered.",
        );
        const failedSubagentId =
          failedSubagent?.type === "subagent.updated" ? failedSubagent.subagent.id : null;
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === WAKE_TASK_ID &&
              event.node.status === "failed",
          ),
        );
        assert.equal(failedToolItems().at(-1)?.status, "failed");
        assert.equal(failedToolItems().filter((item) => item.status === "failed").length, 1);
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "node.updated" &&
              event.node.kind === "root_turn" &&
              event.node.nativeItemRef?.nativeId === WAKE_TASK_ID &&
              event.node.status === "failed",
          ),
        );
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.subagentId === failedSubagentId &&
              event.turnItem.status === "failed" &&
              event.turnItem.result === "Background task completion could not be delivered.",
          ),
        );
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text === "Background task completion could not be delivered.",
          ),
        );
        const siblingSubagent = harness.events.findLast(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === siblingTaskId,
        );
        assert.equal(siblingSubagent?.type, "subagent.updated");
        assert.equal(
          siblingSubagent?.type === "subagent.updated" ? siblingSubagent.subagent.status : null,
          "running",
        );
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* awaitUntil(
          () => harness.continuationRequests.length === 2,
          "sibling continuation offer",
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu-failed-wake-child",
                  content: [{ type: "text", text: "Late failed-child launch result." }],
                },
              ],
            },
            parent_tool_use_id: null,
            tool_use_result: {
              agentId: WAKE_TASK_ID,
              content: [{ type: "text", text: "Late failed-child launch result." }],
            },
            uuid: "00000000-0000-4000-8000-000000000634",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === WAKE_TASK_ID &&
              event.subagent.status === "completed",
          ),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-failed-wake-sibling"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu-failed-wake-child",
                  content: [{ type: "text", text: "Late active failed-child launch result." }],
                },
              ],
            },
            parent_tool_use_id: null,
            tool_use_result: {
              agentId: WAKE_TASK_ID,
              content: [{ type: "text", text: "Late active failed-child launch result." }],
            },
            uuid: "00000000-0000-4000-8000-000000000636",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000635",
            result: "The sibling completed after the failed wake.",
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 2,
          "sibling continuation terminal",
        );
        const completedSibling = harness.events.findLast(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === siblingTaskId,
        );
        assert.equal(completedSibling?.subagent.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === siblingTaskId &&
              event.subagent.status === "failed",
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === WAKE_TASK_ID &&
              event.subagent.status === "completed",
          ),
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("offers an opaque sibling completion after a failed wake dispatch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const siblingTaskId = "task-failed-wake-opaque-sibling";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-failed-wake-opaque"),
            text: "Run two builds in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: siblingTaskId,
            description: "Sibling build",
            task_type: "local_bash",
            uuid: "00000000-0000-4000-8000-000000000637",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "first wake offer");
        const request = harness.continuationRequests[0]!;
        const dispatch = Effect.fail("dispatch failure");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(request.dispatchIfCurrent!(dispatch))));
        yield* request.failIfCurrent!(Cause.fail("dispatch failure"));

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: siblingTaskId,
            status: "completed",
            output_file: "/tmp/task-failed-wake-opaque-sibling.log",
            summary: "The sibling build completed.",
            uuid: "00000000-0000-4000-8000-000000000638",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000639",
            text: "The sibling build has finished.",
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 2, "opaque sibling offer");
        assert.equal(harness.continuationRequests[1]?.detail, "The sibling build completed.");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("retains late subagent alias registration across settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-postsettle-registration-race";
        const toolUseId = "toolu-postsettle-registration-race";
        const childText = "Child narration before the post-settle alias.";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-registration-race-1"),
            text: "Delegate before the alias is available.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            description: "Post-settle registration race",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Finish after the parent settles.",
            uuid: "00000000-0000-4000-8000-000000000625",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(() => subagentEvents().length === 1, "subagent registration");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000626",
            result: "Root settled before alias registration.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000627",
            text: childText,
            parentToolUseId: toolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: taskId,
            tool_use_id: toolUseId,
            description: "   ",
            uuid: "00000000-0000-4000-8000-000000000628",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            status: "completed",
            output_file: "/tmp/task-postsettle-registration-race.output",
            summary: "Post-settle registration completed.",
            uuid: "00000000-0000-4000-8000-000000000629",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000630",
            result: "Post-settle registration completed.",
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation offer");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-postsettle-registration-race-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");

        const childThreadId = subagentEvents()[0]?.subagent.childThreadId;
        assert.ok(childThreadId);
        assert.equal(
          assistantItems().filter(
            (item) => item.threadId === childThreadId && item.text === childText,
          ).length,
          1,
        );
        assert.isFalse(
          assistantItems().some(
            (item) => item.threadId === harness.threadId && item.text === childText,
          ),
        );
        const completedProviderTurn = harness.events.findLast(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completedProviderTurn?.type, "provider_turn.updated");
        assert.isNotNull(
          completedProviderTurn?.type === "provider_turn.updated"
            ? completedProviderTurn.providerTurn.nativeTurnRef
            : null,
        );
        if (
          completedProviderTurn?.type === "provider_turn.updated" &&
          completedProviderTurn.providerTurn.nativeTurnRef !== null
        ) {
          assert.notEqual(
            completedProviderTurn.providerTurn.nativeTurnRef.nativeId,
            "00000000-0000-4000-8000-000000000627",
          );
        }
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("recovers the Agent launch alias when task_started omits tool_use_id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-optional-launch-alias";
        const toolUseId = "toolu-optional-launch-alias";
        const childText = "Child text buffered before an alias-free task_started frame.";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated",
          );
        const assistantItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-optional-launch-alias"),
            text: "Delegate this task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-before-pending-launch",
            description: "Task start before any pending launch",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Start before the Agent tool-use frame.",
            uuid: "00000000-0000-4000-8000-000000000634",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolUseId,
                  name: "Agent",
                  input: { prompt: "Return the child result.", run_in_background: true },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000635",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000636",
            text: childText,
            parentToolUseId: toolUseId,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            description: "Optional launch alias",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Return the child result.",
            uuid: "00000000-0000-4000-8000-000000000637",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => assistantItems().some((item) => item.text === childText),
          "child text routed through recovered launch alias",
        );

        const childThreadId = subagentEvents().at(-1)?.subagent.childThreadId;
        assert.ok(childThreadId);
        assert.equal(
          assistantItems().find((item) => item.text === childText)?.threadId,
          childThreadId,
        );
        assert.isFalse(
          assistantItems().some(
            (item) => item.threadId === harness.threadId && item.text === childText,
          ),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000638",
            result: "Root delegation complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("does not terminalize a resumed subagent from a cross-turn delivery ack", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-cross-turn-resume-ack";
        const launchToolUseId = "toolu-cross-turn-resume-launch";
        const resumeToolUseId = "toolu-cross-turn-resume-message";
        const subagentEvents = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === taskId,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cross-turn-resume-ack-1"),
            text: "Launch and complete the subagent.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: launchToolUseId,
            description: "Cross-turn resume ack",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Complete, then resume.",
            uuid: "00000000-0000-4000-8000-000000000639",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: taskId,
            tool_use_id: launchToolUseId,
            status: "completed",
            output_file: "/tmp/task-cross-turn-resume-ack.output",
            summary: "Initial generation completed.",
            uuid: "00000000-0000-4000-8000-000000000640",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000641",
            result: "Initial generation complete.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cross-turn-resume-ack-2"),
            text: "Resume the subagent.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: resumeToolUseId,
                  name: "SendMessage",
                  input: { agent_id: taskId, message: "Resume." },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000642",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: resumeToolUseId,
            description: "Cross-turn resume ack",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Complete, then resume.",
            uuid: "00000000-0000-4000-8000-000000000643",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000644",
            result: "Resume sent before its acknowledgement arrived.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "resume turn terminal");
        assert.equal(subagentEvents().at(-1)?.subagent.status, "running");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cross-turn-resume-ack-3"),
            text: "Observe the delayed acknowledgement.",
            attachments: [],
            providerTurnOrdinal: 3,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: resumeToolUseId,
                  content: '{"success":true,"message":"Message delivered."}',
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000645",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.nativeItemRef?.nativeId === resumeToolUseId &&
                event.turnItem.status === "completed",
            ),
          "delivery acknowledgement projected as a tool result",
        );
        assert.equal(subagentEvents().at(-1)?.subagent.status, "running");
        assert.isNull(subagentEvents().at(-1)?.subagent.result);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000646",
            result: "Delayed acknowledgement observed.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "ack turn terminal");
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
    ),
  );

  it.effect("keeps a subagent tool ordinal stable across turn re-derivation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const taskId = "task-cross-turn-tool-ordinal";
        const launchToolUseId = "toolu-cross-turn-tool-launch";
        const childToolUseId = "toolu-cross-turn-child-tool";
        const childToolItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === childToolUseId
              ? [event.turnItem]
              : [],
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cross-turn-tool-ordinal-1"),
            text: "Launch a child tool call.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            tool_use_id: launchToolUseId,
            description: "Cross-turn child tool",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Run one tool across the turn boundary.",
            uuid: "00000000-0000-4000-8000-000000000647",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: childToolUseId,
                  name: "Bash",
                  input: { command: "printf done" },
                },
              ],
            },
            parent_tool_use_id: launchToolUseId,
            uuid: "00000000-0000-4000-8000-000000000648",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => childToolItems().at(-1)?.status === "running",
          "child tool started",
        );
        const startedItem = childToolItems().at(-1);
        assert.isDefined(startedItem);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000649",
            result: "Root turn settled while the child tool ran.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.equal(childToolItems().at(-1)?.status, "running");
        assert.isFalse(childToolItems().some((item) => item.status === "failed"));

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cross-turn-tool-ordinal-2"),
            text: "Receive the child tool result.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: childToolUseId,
                  content: "done",
                },
              ],
            },
            parent_tool_use_id: launchToolUseId,
            uuid: "00000000-0000-4000-8000-000000000650",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* awaitUntil(
          () => childToolItems().at(-1)?.status === "completed",
          "child tool completed",
        );
        const completedItem = childToolItems().at(-1);
        assert.isDefined(completedItem);
        assert.equal(completedItem?.id, startedItem?.id);
        assert.equal(completedItem?.ordinal, startedItem?.ordinal);
        assert.equal(completedItem?.threadId, startedItem?.threadId);
        const childToolStatuses = childToolItems().map((item) => item.status);
        assert.equal(childToolStatuses[0], "running");
        assert.equal(childToolStatuses.at(-1), "completed");
        assert.equal(childToolStatuses.filter((status) => status === "completed").length, 1);
        assert.isFalse(childToolStatuses.includes("failed"));
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000651",
            result: "Child tool result received.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "second turn terminal");
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
      // Never yields a message — the read stays pending until close() flips
      // `closed` and releases the in-flight await.
      // oxlint-disable-next-line require-yield
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        for (;;) {
          if (closed) return;
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
