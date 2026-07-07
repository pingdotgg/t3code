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

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
  ClaudeProviderCapabilitiesV2,
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
    });
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
