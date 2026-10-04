import assert, * as NodeAssert from "node:assert/strict";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { beforeEach, vi } from "vitest";
import type { Event as OpenCodeEvent, ToolPart } from "@opencode-ai/sdk/v2";

import {
  ApprovalRequestId,
  EnvironmentId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
    parentID?: string;
    error?: unknown;
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    abortError: null as Error | null,
    closeCalls: [] as string[],
    revertMessageID: undefined as string | undefined,
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    sessionStatus: "idle" as "busy" | "idle" | undefined,
    subscribeFailures: 0,
    subscribeCalls: 0,
    subscribedEvents: [] as unknown[],
    subscribedEventDelayMs: 0,
    sessionParents: new Map<string, string | undefined>(),
    sessionGetCalls: [] as string[],
    permissionReplies: [] as Array<{ requestID: string; reply: string }>,
    permissionReplyError: null as Error | null,
    listedPermissions: [] as Array<Record<string, unknown>>,
    permissionListError: null as Error | null,
    questionReplies: [] as Array<{ requestID: string; answers: string[][] }>,
    questionReplyError: null as Error | null,
    listedQuestions: [] as Array<Record<string, unknown>>,
    questionListError: null as Error | null,
    sessionGetIds: [] as string[],
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
    sessionChildren: new Map<string, Array<{ id: string }>>(),
    sessionChildrenCalls: [] as string[],
    mcpAddCalls: [] as Array<Record<string, unknown>>,
    mcpStatus: "connected" as "connected" | "failed" | "needs_auth",
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.abortError = null;
    this.state.closeCalls.length = 0;
    this.state.revertMessageID = undefined;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.sessionStatus = "idle";
    this.state.subscribeFailures = 0;
    this.state.subscribeCalls = 0;
    this.state.subscribedEvents = [];
    this.state.subscribedEventDelayMs = 0;
    this.state.sessionParents.clear();
    this.state.sessionGetCalls = [];
    this.state.permissionReplies = [];
    this.state.permissionReplyError = null;
    this.state.listedPermissions = [];
    this.state.permissionListError = null;
    this.state.questionReplies = [];
    this.state.questionReplyError = null;
    this.state.listedQuestions = [];
    this.state.questionListError = null;
    this.state.sessionGetIds.length = 0;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
    this.state.sessionChildren.clear();
    this.state.sessionChildrenCalls.length = 0;
    this.state.mcpAddCalls.length = 0;
    this.state.mcpStatus = "connected";
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetCalls.push(sessionID);
          runtimeMock.state.sessionGetIds.push(sessionID);
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          if (
            !runtimeMock.state.sessionParents.has(sessionID) &&
            directory === undefined &&
            !sessionID.startsWith("ses_") &&
            sessionID !== `${baseUrl}/session`
          ) {
            throw new Error(`Unknown session: ${sessionID}`);
          }
          return {
            data: {
              id: sessionID,
              ...(runtimeMock.state.revertMessageID
                ? { revert: { messageID: runtimeMock.state.revertMessageID } }
                : {}),
              ...(runtimeMock.state.sessionParents.has(sessionID)
                ? { parentID: runtimeMock.state.sessionParents.get(sessionID) }
                : {}),
              ...(directory ? { directory } : {}),
            },
          };
        },
        create: async () => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });
          return { data: { id: sessionID } };
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
          // Fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });
          if (directory) {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          runtimeMock.state.sessionStatus = "idle";
          if (runtimeMock.state.abortError) {
            throw runtimeMock.state.abortError;
          }
        },
        children: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionChildrenCalls.push(sessionID);
          return { data: runtimeMock.state.sessionChildren.get(sessionID) ?? [] };
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
          runtimeMock.state.sessionStatus = "busy";
        },
        message: async ({ messageID }: { sessionID: string; messageID: string }) => {
          const message = runtimeMock.state.messages.find((entry) => entry.info.id === messageID);
          if (!message) {
            throw new Error("message not found");
          }
          return { data: message };
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        status: async () => ({
          data:
            runtimeMock.state.sessionStatus === undefined
              ? {}
              : {
                  "http://127.0.0.1:9999/session": { type: runtimeMock.state.sessionStatus },
                },
        }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            throw new Error("Expected messageID");
          }

          let lastUserID: string | undefined;
          for (const entry of runtimeMock.state.messages) {
            if (entry.info.role === "user") {
              lastUserID = entry.info.id;
            }
            if (entry.info.id === messageID) {
              runtimeMock.state.revertMessageID = lastUserID ?? messageID;
              break;
            }
          }
        },
      },
      event: {
        subscribe: async () => {
          runtimeMock.state.subscribeCalls += 1;
          if (runtimeMock.state.subscribeFailures > 0) {
            runtimeMock.state.subscribeFailures -= 1;
            throw new Error("event stream disconnected");
          }
          return {
            stream: (async function* () {
              for (const event of runtimeMock.state.subscribedEvents) {
                if (runtimeMock.state.subscribedEventDelayMs > 0) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, runtimeMock.state.subscribedEventDelayMs),
                  );
                }
                yield event;
              }
            })(),
          };
        },
      },
      permission: {
        list: async () => {
          if (runtimeMock.state.permissionListError) throw runtimeMock.state.permissionListError;
          return { data: runtimeMock.state.listedPermissions };
        },
        reply: async (input: { requestID: string; reply: string }) => {
          runtimeMock.state.permissionReplies.push(input);
          if (runtimeMock.state.permissionReplyError) {
            throw runtimeMock.state.permissionReplyError;
          }
        },
      },
      question: {
        list: async () => {
          if (runtimeMock.state.questionListError) throw runtimeMock.state.questionListError;
          return { data: runtimeMock.state.listedQuestions };
        },
        reply: async (input: { requestID: string; answers: string[][] }) => {
          runtimeMock.state.questionReplies.push(input);
          if (runtimeMock.state.questionReplyError) {
            throw runtimeMock.state.questionReplyError;
          }
        },
      },
      mcp: {
        add: async (input: Record<string, unknown>) => {
          runtimeMock.state.mcpAddCalls.push(input);
          return { data: { "t3-code": { status: runtimeMock.state.mcpStatus } } };
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadOpenCodeSkillsForCwd: () => Effect.succeed([]),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getBinding: () => Effect.succeed(Option.none()),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  Effect.gen(function* () {
    return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings);
  }),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeLocalMcpAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(
    Schema.decodeSync(OpenCodeSettings)({
      binaryPath: "fake-opencode",
    }),
  ),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const mcpSessionRegistryTestLayer = McpSessionRegistry.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("opencode-adapter-test")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

it.layer(Layer.merge(OpenCodeLocalMcpAdapterTestLayer, mcpSessionRegistryTestLayer))(
  "OpenCodeAdapterLive MCP routing",
  (it) => {
    for (const status of ["failed", "needs_auth"] as const) {
      it.effect(`rejects session startup when T3 MCP registration is ${status}`, () =>
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const threadId = asThreadId(`thread-opencode-mcp-${status}`);
          yield* McpSessionRegistry.issueActiveMcpCredential({
            threadId,
            providerInstanceId: ProviderInstanceId.make("opencode"),
          });
          runtimeMock.state.mcpStatus = status;

          const result = yield* adapter
            .startSession({
              provider: ProviderDriverKind.make("opencode"),
              threadId,
              runtimeMode: "full-access",
            })
            .pipe(Effect.result);

          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.match(result.failure.message, /MCP.*registration.*(?:failed|needs_auth)/);
          }
          assert.equal(yield* adapter.hasSession(threadId), false);
          assert.equal(runtimeMock.state.sessionCreateUrls.length, 0);
          assert.equal(runtimeMock.state.closeCalls.length, 1);
        }),
      );
    }

    it.effect("adds only the thread t3-code MCP server to the requested OpenCode directory", () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-mcp-directory");
        const directory = "/tmp/thread-opencode-mcp-directory";
        yield* McpSessionRegistry.issueActiveMcpCredential({
          threadId,
          providerInstanceId: ProviderInstanceId.make("opencode"),
        });

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
        });

        // Exactly one MCP server. A second `t3-tools` server would advertise a
        // duplicate `delegate_work` with a different schema than the one the
        // `t3-code` DelegationToolkit serves.
        assert.equal(runtimeMock.state.mcpAddCalls.length, 1);
        const call = runtimeMock.state.mcpAddCalls[0];
        assert.equal(call?.directory, directory);
        assert.equal(call?.name, "t3-code");
        const config = call?.config as
          | {
              type?: unknown;
              url?: unknown;
              headers?: { Authorization?: unknown };
              oauth?: unknown;
            }
          | undefined;
        assert.equal(config?.type, "remote");
        assert.match(String(config?.url), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        assert.match(String(config?.headers?.Authorization), /^Bearer \S+$/);
        assert.equal(config?.oauth, false);
      }),
    );
  },
);

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  for (const runtimeMode of ["full-access", "approval-required", "auto-accept-edits"] as const) {
    it.effect(`routes descendant directory approvals in ${runtimeMode}`, () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`child-approval-${runtimeMode}`);
        const root = "http://127.0.0.1:9999/session";
        runtimeMock.state.sessionParents.set("child", root);
        runtimeMock.state.sessionParents.set("grandchild", "child");
        runtimeMock.state.sessionParents.set("unrelated", undefined);
        const permission = (sessionID: string, id: string) => ({
          type: "permission.asked",
          properties: {
            sessionID,
            id,
            permission: "external_directory",
            patterns: ["/repo-worktree/*"],
            always: ["/repo-worktree/*"],
            metadata: {},
          },
        });
        runtimeMock.state.subscribedEvents = [
          permission("unrelated", "foreign"),
          permission("grandchild", "directory"),
          permission("grandchild", "next-directory"),
          { type: "session.status", properties: { sessionID: "child", status: { type: "idle" } } },
          {
            type: "session.error",
            properties: { sessionID: "child", error: { name: "child-error" } },
          },
          { type: "question.asked", properties: { sessionID: root, id: "barrier", questions: [] } },
        ];
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil(
            (event) => event.type === "user-input.requested" && event.requestId === "barrier",
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode,
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(runtimeMock.state.sessionGetCalls, ["unrelated", "grandchild", "child"]);
        const requests = events.filter((event) => event.type === "request.opened");
        assert.equal(
          events.some((event) => event.type === "turn.completed" || event.type === "runtime.error"),
          false,
        );
        assert.equal(
          events.every((event) => event.threadId === threadId),
          true,
        );
        if (runtimeMode === "full-access") {
          assert.equal(requests.length, 0);
          assert.deepEqual(runtimeMock.state.permissionReplies, [
            { requestID: "directory", reply: "once" },
            { requestID: "next-directory", reply: "once" },
          ]);
        } else {
          assert.deepEqual(
            requests.map((event) => event.requestId),
            ["directory", "next-directory"],
          );
          assert.deepEqual(
            requests.map((event) => event.payload.requestType),
            ["dynamic_tool_call", "dynamic_tool_call"],
          );
          assert.equal(requests[0]?.payload.detail, "external_directory: /repo-worktree/*");
          yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("directory"), "accept");
          assert.deepEqual(runtimeMock.state.permissionReplies, [
            { requestID: "directory", reply: "once" },
          ]);
        }
        yield* adapter.stopSession(threadId);
      }),
    );
  }

  it.effect("surfaces descendant questions in full-access and routes answers to OpenCode", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("child-question");
      const root = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionParents.set("child", root);
      runtimeMock.state.subscribedEvents = [
        {
          type: "question.asked",
          properties: {
            sessionID: "child",
            id: "child-input",
            questions: [
              {
                question: "Which target?",
                header: "Target",
                options: [{ label: "Local", description: "Local target" }],
              },
            ],
          },
        },
        { type: "question.asked", properties: { sessionID: root, id: "barrier", questions: [] } },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) => event.type === "user-input.requested" && event.requestId === "barrier",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const request = events.find(
        (event) => event.type === "user-input.requested" && event.requestId === "child-input",
      );
      assert.ok(request?.type === "user-input.requested");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("child-input"), {
        [request.payload.questions[0]!.id]: "Local",
      });
      assert.deepEqual(runtimeMock.state.questionReplies, [
        { requestID: "child-input", answers: [["Local"]] },
      ]);
      assert.deepEqual(runtimeMock.state.permissionReplies, []);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not approve requests when descendant ownership cannot be established", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("child-ownership-failure");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: "missing-session",
            id: "unverified-request",
            permission: "external_directory",
            patterns: ["/repo-worktree/*"],
            always: [],
            metadata: {},
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(runtimeMock.state.permissionReplies, []);
      assert.equal(
        events.some((event) => event.type === "request.opened"),
        false,
      );
      assert.equal(
        events.some((event) => event.type === "runtime.error"),
        true,
      );
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("surfaces a full-access permission when its automatic reply fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("full-access-auto-reply-failure");
      const root = "http://127.0.0.1:9999/session";
      runtimeMock.state.permissionReplyError = new Error("reply failed");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: root,
            id: "doom-loop",
            permission: "doom_loop",
            patterns: ["bash"],
            always: [],
            metadata: {},
          },
        },
      ];
      const requestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const request = Option.getOrUndefined(
        yield* Fiber.join(requestFiber).pipe(Effect.timeout("1 second")),
      );
      assert.equal(request?.requestId, "doom-loop");
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "doom-loop", reply: "once" },
      ]);
      runtimeMock.state.permissionReplyError = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not reopen or resolve an auto-replied full-access permission", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("full-access-auto-reply-deduplication");
      const root = "http://127.0.0.1:9999/session";
      const permission = {
        sessionID: root,
        id: "duplicate-doom-loop",
        permission: "doom_loop",
        patterns: ["bash"],
        always: [],
        metadata: {},
      };
      runtimeMock.state.subscribedEvents = [
        { type: "permission.asked", properties: permission },
        { type: "permission.asked", properties: permission },
        {
          type: "permission.replied",
          properties: { sessionID: root, requestID: permission.id, reply: "once" },
        },
        { type: "question.asked", properties: { sessionID: root, id: "barrier", questions: [] } },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) => event.type === "user-input.requested" && event.requestId === "barrier",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));

      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: permission.id, reply: "once" },
      ]);
      assert.equal(
        events.some(
          (event) => event.type === "request.opened" || event.type === "request.resolved",
        ),
        false,
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers pending permissions when attaching to an OpenCode session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("recover-pending-permission");
      runtimeMock.state.listedPermissions = [
        {
          sessionID: "http://127.0.0.1:9999/session",
          id: "recovered-permission",
          permission: "external_directory",
          patterns: ["/repo-worktree/*"],
          always: [],
          metadata: {},
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) => event.type === "request.opened" && event.requestId === "recovered-permission",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const request = events.find(
        (event) => event.type === "request.opened" && event.requestId === "recovered-permission",
      );
      assert.equal(request?.type, "request.opened");
      if (request?.type === "request.opened") {
        assert.equal(request.payload.requestType, "dynamic_tool_call");
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers permissions when question recovery fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("partial-pending-recovery");
      runtimeMock.state.questionListError = new Error("question list failed");
      runtimeMock.state.listedPermissions = [
        {
          sessionID: "http://127.0.0.1:9999/session",
          id: "recoverable-permission",
          permission: "read",
          patterns: ["/repo/file.ts"],
          always: [],
          metadata: {},
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "request.opened" && event.requestId === "recoverable-permission",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.equal(
        events.some(
          (event) =>
            event.type === "request.opened" && event.requestId === "recoverable-permission",
        ),
        true,
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resolves an approval immediately after OpenCode accepts the response", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("resolve-permission-response");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            id: "permission-to-resolve",
            permission: "read",
            patterns: ["/repo/file.ts"],
            always: [],
            metadata: {},
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "request.resolved" && event.requestId === "permission-to-resolve",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* sleep(10);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("permission-to-resolve"),
        "accept",
      );

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const resolved = events.find(
        (event) => event.type === "request.resolved" && event.requestId === "permission-to-resolve",
      );
      assert.equal(resolved?.type, "request.resolved");
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.requestType, "file_read_approval");
        assert.equal(resolved.payload.decision, "accept");
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps an approval pending when OpenCode rejects the response", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("failed-permission-response");
      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            id: "retryable-permission",
            permission: "edit",
            patterns: ["/repo/file.ts"],
            always: [],
            metadata: {},
          },
        },
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* sleep(10);
      runtimeMock.state.permissionReplyError = new Error("reply failed");

      const error = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make("retryable-permission"), "accept")
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");

      runtimeMock.state.permissionReplyError = null;
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("retryable-permission"),
        "accept",
      );
      assert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: "retryable-permission", reply: "once" },
        { requestID: "retryable-permission", reply: "once" },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("classifies TodoWrite as task activity instead of a file change", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("todo-write-classification");
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              id: "todo-part",
              messageID: "todo-message",
              sessionID: "http://127.0.0.1:9999/session",
              type: "tool",
              callID: "todo-call",
              tool: "TodoWrite",
              state: {
                status: "running",
                input: { todos: [] },
                time: { start: 1 },
              },
            },
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "item.updated"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const item = events.find((event) => event.type === "item.updated");
      assert.equal(item?.type, "item.updated");
      if (item?.type === "item.updated") {
        assert.equal(item.payload.itemType, "dynamic_tool_call");
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "opencode");
      assert.equal(session.threadId, "thread-opencode");
      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      assert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("returns a durable resume cursor for a freshly created session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      // Without a persisted cursor, a session is created and its id is
      // surfaced as a resume cursor so the upper layer can persist it.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the persisted OpenCode session instead of creating a new one", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      // The adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_persisted"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });
      // Resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_persisted");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends follow-up turns to the resumed session id", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-turn");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "continue where we left off",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      // The prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        "ses_persisted",
      );
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to a fresh session when the persisted session is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale");
      runtimeMock.state.missingSessionIds.add("ses_stale");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_stale" },
      });

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_stale"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a malformed or wrong-version resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-badcursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "ses_persisted" },
      });

      // A foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a non-not-found resume probe error instead of silently starting fresh", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-transient");
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add("ses_transient");

      const exit = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_transient" },
        }),
      );

      // A transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_transient"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
    }),
  );

  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("reuses the resumed session when the stored directory differs only lexically", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-samedir");
      // Same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set("ses_samedir", `${process.cwd()}/`);

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_samedir" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_samedir"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_samedir",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      assert.deepEqual(runtimeMock.state.startCalls, []);
      assert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("aborts descendant sessions when interrupting a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-stop");
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionChildren.set(rootSessionId, [{ id: "ses_child" }]);
      runtimeMock.state.sessionChildren.set("ses_child", [{ id: "ses_grandchild" }]);
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "delegate work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      yield* adapter.interruptTurn(threadId, turn.turnId);

      assert.deepEqual(runtimeMock.state.abortCalls, [
        rootSessionId,
        "ses_child",
        "ses_grandchild",
      ]);
      assert.deepEqual(runtimeMock.state.sessionChildrenCalls, [
        rootSessionId,
        "ses_child",
        "ses_grandchild",
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps an interrupted turn terminal when delayed idle and abort events arrive", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-delayed-stop-events");
      runtimeMock.state.subscribedEventDelayMs = 30;
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "idle" },
          },
        },
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: { name: "MessageAbortedError", message: "Aborted" },
          },
        },
      ];
      const observedEvents: Array<{ type: string }> = [];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            observedEvents.push(event);
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      const followUp = yield* adapter.sendTurn({
        threadId,
        input: "continue after the stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });
      yield* sleep(100);

      const [session] = yield* adapter.listSessions();
      assert.equal(session?.status, "running");
      assert.equal(session?.activeTurnId, followUp.turnId);
      assert.equal(observedEvents.filter((event) => event.type === "turn.aborted").length, 1);
      assert.equal(
        observedEvents.some(
          (event) => event.type === "turn.completed" || event.type === "runtime.error",
        ),
        false,
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a delayed busy event after an interrupted turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-delayed-busy-after-stop");
      runtimeMock.state.subscribedEventDelayMs = 30;
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "busy" },
          },
        },
      ];

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "stop before delayed busy",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* sleep(100);

      const [session] = yield* adapter.listSessions();
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps the turn running when OpenCode abort fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-failure");
      runtimeMock.state.subscribedEventDelayMs = 1_000;
      runtimeMock.state.subscribedEvents = [
        {
          type: "question.asked",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            id: "keep-event-pump-open",
            questions: [],
          },
        },
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "do not report a false stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });
      runtimeMock.state.abortError = new Error("abort failed");
      const [beforeInterrupt] = yield* adapter.listSessions();

      const error = yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.flip);
      const [session] = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(session?.status, beforeInterrupt?.status);
      assert.equal(session?.activeTurnId, beforeInterrupt?.activeTurnId);
      runtimeMock.state.abortError = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      assert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      assert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        assert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(error.detail, "prompt failed");
      assert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
      assert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      const promptCall = { ...(runtimeMock.state.promptCalls.at(-1) as Record<string, unknown>) };
      assert.equal(typeof promptCall.messageID, "string");
      assert.match(promptCall.messageID as string, /^msg-/);
      delete promptCall.messageID;
      assert.deepEqual(promptCall, {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("does not dispatch the retired plan agent from persisted selections or modes", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-retired-plan-agent");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
        interactionMode: "plan",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5", [
          { id: "agent", value: "plan" },
        ]),
      });

      const promptCall = { ...(runtimeMock.state.promptCalls.at(-1) as Record<string, unknown>) };
      assert.equal(typeof promptCall.messageID, "string");
      delete promptCall.messageID;
      assert.deepEqual(promptCall, {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }),
  );

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      const promptCall = { ...(runtimeMock.state.promptCalls.at(-1) as Record<string, unknown>) };
      assert.equal(typeof promptCall.messageID, "string");
      delete promptCall.messageID;
      assert.deepEqual(promptCall, {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reconciles a completed prompt when SSE has no semantic events", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-silent-sse");
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Recover this silent turn",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

      yield* sleep(150);
      runtimeMock.state.messages = [
        {
          info: { id: prompt.messageID, role: "user" },
          parts: [{ id: "user-part", type: "text", messageID: prompt.messageID, text: "Recover" }],
        },
        {
          info: {
            id: "assistant-silent",
            role: "assistant",
            parentID: prompt.messageID,
          },
          parts: [
            {
              id: "assistant-part",
              messageID: "assistant-silent",
              type: "text",
              text: "Recovered output",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
      runtimeMock.state.sessionStatus = "idle";

      const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("2 seconds")));
      const completed = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(completed.length, 1);
      assert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["Recovered output"],
      );
    }),
  );

  it.effect("reconciles only the current turn and never replays earlier history", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-history-replay");
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "New turn",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

      yield* sleep(150);
      runtimeMock.state.messages = [
        {
          info: { id: "old-prompt", role: "user" },
          parts: [{ id: "old-user-part", type: "text", messageID: "old-prompt", text: "Old" }],
        },
        {
          info: { id: "old-assistant", role: "assistant", parentID: "old-prompt" },
          parts: [
            {
              id: "old-tool-part",
              messageID: "old-assistant",
              type: "tool",
              callID: "old-call",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "",
                title: "ls",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
            {
              id: "old-text-part",
              messageID: "old-assistant",
              type: "text",
              text: "Old output",
              time: { start: 1, end: 2 },
            },
          ],
        },
        {
          info: { id: prompt.messageID, role: "user" },
          parts: [{ id: "user-part", type: "text", messageID: prompt.messageID, text: "New" }],
        },
        {
          info: { id: "new-assistant", role: "assistant", parentID: prompt.messageID },
          parts: [
            {
              id: "new-text-part",
              messageID: "new-assistant",
              type: "text",
              text: "New output",
              time: { start: 3, end: 4 },
            },
          ],
        },
      ];
      runtimeMock.state.sessionStatus = "idle";

      const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("2 seconds")));
      assert.equal(
        events.filter((event) => event.type === "turn.completed" && event.turnId === turn.turnId)
          .length,
        1,
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["New output"],
      );
      assert.deepEqual(
        events.filter((event) => event.itemId === "old-call" || event.itemId === "old-text-part"),
        [],
      );
    }),
  );

  it.effect(
    "reconciles from an assistant parent when the prompt is absent from the transcript page",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-truncated-transcript");
        const observed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Recover from a truncated transcript",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        });
        const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

        yield* sleep(150);
        runtimeMock.state.messages = [
          {
            info: {
              id: "assistant-truncated-transcript",
              role: "assistant",
              parentID: prompt.messageID,
            },
            parts: [
              {
                id: "assistant-part",
                messageID: "assistant-truncated-transcript",
                type: "text",
                text: "Recovered from the parent correlation",
                time: { start: 1, end: 2 },
              },
            ],
          },
        ];
        runtimeMock.state.sessionStatus = "idle";

        const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("2 seconds")));
        const completed = events.filter(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        assert.equal(completed.length, 1);
      }),
  );

  it.effect("treats an omitted session status as idle after correlated output is present", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-omitted-idle-status");
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Finish when idle sessions are omitted",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

      yield* sleep(150);
      runtimeMock.state.messages = [
        {
          info: { id: prompt.messageID, role: "user" },
          parts: [{ id: "user-part", type: "text", messageID: prompt.messageID, text: "Finish" }],
        },
        {
          info: {
            id: "assistant-omitted-idle-status",
            role: "assistant",
            parentID: prompt.messageID,
          },
          parts: [
            {
              id: "assistant-part",
              messageID: "assistant-omitted-idle-status",
              type: "text",
              text: "Completed while absent from the active status map",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
      runtimeMock.state.sessionStatus = undefined;

      const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("2 seconds")));
      const completed = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(completed.length, 1);
    }),
  );

  it.effect("retains native idle evidence when the status endpoint remains stale busy", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale-busy-status");
      runtimeMock.state.subscribedEventDelayMs = 50;
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "idle" },
          },
        },
      ];
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Finish despite stale polled status",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

      yield* sleep(150);
      runtimeMock.state.messages = [
        {
          info: { id: prompt.messageID, role: "user" },
          parts: [{ id: "user-part", type: "text", messageID: prompt.messageID, text: "Finish" }],
        },
        {
          info: {
            id: "assistant-stale-busy-status",
            role: "assistant",
            parentID: prompt.messageID,
          },
          parts: [
            {
              id: "assistant-part",
              messageID: "assistant-stale-busy-status",
              type: "text",
              text: "Completed after native idle",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];

      const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("2 seconds")));
      const completed = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(completed.length, 1);
    }),
  );

  it.effect("does not fail a long-running prompt before its transcript is idle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-long-running-recovery");
      const observed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Wait for the long-running transcript",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID: string };

      yield* sleep(2_600);
      runtimeMock.state.messages = [
        {
          info: { id: prompt.messageID, role: "user" },
          parts: [{ id: "user-part", type: "text", messageID: prompt.messageID, text: "Wait" }],
        },
        {
          info: {
            id: "assistant-long-running",
            role: "assistant",
            parentID: prompt.messageID,
          },
          parts: [
            {
              id: "assistant-part",
              messageID: "assistant-long-running",
              type: "text",
              text: "Completed after a long native turn",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ];
      runtimeMock.state.sessionStatus = "idle";

      const events = Array.from(yield* Fiber.join(observed).pipe(Effect.timeout("5 seconds")));
      const completed = events.filter(
        (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
      );
      assert.equal(completed.length, 1);
    }),
  );

  it.effect("waits for an event reconnect before admitting a prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-reconnect");
      runtimeMock.state.subscribeFailures = 1;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      assert.ok(runtimeMock.state.subscribeCalls >= 2);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("bounds initial event connection retries", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-connection-timeout");
      runtimeMock.state.subscribeFailures = 100;

      const error = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterProcessError");
      assert.ok(runtimeMock.state.subscribeCalls >= 5);
      assert.equal(runtimeMock.state.abortCalls.length, 1);
    }),
  );

  it.effect("rejects a follow-up when the native session remains busy", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-native-busy-follow-up");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Follow-up",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.match(error.detail, /active turn|busy/);
      }
    }),
  );

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const customInstanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      Effect.gen(function* () {
        return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          instanceId: customInstanceId,
        });
      }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      assert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      assert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts from the first removed assistant message", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        { info: { id: "user-1", role: "user" }, parts: [] },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [{ id: "part-1", type: "text", text: "first answer" }],
        },
        { info: { id: "user-2", role: "user" }, parts: [] },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [{ id: "part-2", type: "text", text: "second answer" }],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      assert.deepEqual(runtimeMock.state.revertCalls, [
        {
          sessionID: "http://127.0.0.1:9999/session",
          messageID: "assistant-1",
        },
      ]);
      assert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("classifies a confirmed not-found across the shapes the SDK/runtime can produce", () =>
    Effect.sync(() => {
      // The real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error("Session not found: ses_x", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      });
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: "OpenCodeRuntimeError",
          operation: "session.get",
          detail: "Session not found: ses_x",
          cause: wrappedError,
        }),
        true,
      );

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true);
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error("x", { cause: { status: 404 } })), true);
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true);
      // OpenCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: "NotFoundError" } }), true);

      // NOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error("upstream provider not found", { cause: { status: 500 } })),
        false,
      );
      NodeAssert.equal(isOpenCodeNotFound({ detail: "status=500 body={...not found...}" }), false);
      // An explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // *NotFound* — is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } }), false);
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError", status: 500 }), false);
      // A "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError" }), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: "ProviderNotFoundError" } }), false);
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error("x", { cause: { status: 502, body: { name: "NotFoundError" } } }),
        ),
        false,
      );
      // Other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error("boom", { cause: { status: 500 } })), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false);
      NodeAssert.equal(isOpenCodeNotFound(new Error("network error (no response)")), false);
      NodeAssert.equal(isOpenCodeNotFound(undefined), false);
    }),
  );

  it.effect("treats lexically or physically identical directories as the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right);

      // Lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory("/repo/project/", "/repo/project"), true);
      NodeAssert.equal(yield* sameDirectory("/repo/nested/../project", "/repo/project"), true);
      // Nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory("/repo/project", "/repo/other"), false);

      // A symlinked cwd (the macOS `/tmp` → `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-dir-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      yield* fileSystem.symlink(real, link);
      NodeAssert.equal(yield* sameDirectory(link, real), true);
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, "other")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");
      const replacement = mergeOpenCodeAssistantText(secondUpdate.latestText, "Hello again");

      assert.deepEqual(
        [
          [firstUpdate.deltaToEmit, firstUpdate.replaceExisting],
          [overlapDelta.deltaToEmit, false],
          [secondUpdate.deltaToEmit, secondUpdate.replaceExisting],
          [replacement.deltaToEmit, replacement.replaceExisting],
        ],
        [
          ["Hello", false],
          ["lo world", false],
          ["", false],
          ["Hello again", true],
        ],
      );
      assert.equal(secondUpdate.latestText, "Hellolo world");
      assert.equal(replacement.latestText, "Hello again");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      assert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        assert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("emits tool lifecycle events before late assistant metadata", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-tool-lifecycle");
      const sessionID = "http://127.0.0.1:9999/session";
      const messageID = "msg-tools-before-role";
      const input = { command: "pwd" };
      const states = [
        { status: "pending", input, raw: "" },
        { status: "running", input, title: "Working directory", time: { start: 1 } },
        {
          status: "completed",
          input,
          output: "/repo\n",
          title: "Working directory",
          metadata: {},
          time: { start: 1, end: 2 },
        },
        { status: "error", input, error: "Command failed", time: { start: 3, end: 4 } },
      ] satisfies ReadonlyArray<ToolPart["state"]>;
      runtimeMock.state.subscribedEvents = [
        ...states.map(
          (state) =>
            ({
              id: `evt-tool-${state.status}`,
              type: "message.part.updated",
              properties: {
                sessionID,
                time: 4,
                part: {
                  id: state.status === "error" ? "part-failed" : "part-working",
                  sessionID,
                  messageID,
                  type: "tool",
                  callID: state.status === "error" ? "call-failed" : "call-working",
                  tool: "bash",
                  state,
                },
              },
            }) satisfies OpenCodeEvent,
        ),
        {
          id: "evt-text-before-role",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 4,
            part: {
              id: "part-late-text",
              sessionID,
              messageID,
              type: "text",
              text: "Tool results received",
              time: { start: 4 },
            },
          },
        },
        {
          id: "evt-late-assistant-role",
          type: "message.updated",
          properties: { sessionID, info: { id: messageID, role: "assistant" } },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed" ||
              event.type === "content.delta"),
        ),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second"));
      const tools = events.filter(
        (event) =>
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed",
      );
      NodeAssert.deepEqual(
        tools.map((event) => [event.type, event.itemId, event.payload.status]),
        [
          ["item.started", "call-working", "inProgress"],
          ["item.updated", "call-working", "inProgress"],
          ["item.completed", "call-working", "completed"],
          ["item.completed", "call-failed", "failed"],
        ],
      );
      NodeAssert.partialDeepStrictEqual(tools[2]?.payload.data, {
        tool: "bash",
        state: {
          input: { command: "pwd" },
          output: "/repo\n",
        },
      });
      NodeAssert.partialDeepStrictEqual(tools[3]?.payload.data, {
        tool: "bash",
        state: {
          input: { command: "pwd" },
          error: "Command failed",
        },
      });
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        ["Tool results received"],
      );
    }),
  );

  it.effect("processes late assistant metadata without visiting completed turns", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-indexed-opencode-parts");
      const sessionID = "http://127.0.0.1:9999/session";
      let countingHistoryVisits = false;
      let visitedHistoryParts = 0;
      const currentInfo = { id: "current-message" } as {
        id: string;
        role: "assistant";
      };
      Object.defineProperty(currentInfo, "role", {
        enumerable: true,
        get: () => {
          countingHistoryVisits = true;
          return "assistant";
        },
      });
      const subscribedEvents: unknown[] = [];
      for (let index = 0; index < 24; index += 1) {
        subscribedEvents.push({
          type: "message.updated",
          properties: { sessionID, info: { id: `history-message-${index}`, role: "assistant" } },
        });
        subscribedEvents.push({
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: `history-part-${index}`,
              messageID: `history-message-${index}`,
              sessionID,
              type: "text",
              text: `Completed turn ${index}`,
              time: { start: 1, end: 2 },
            },
          },
        });
      }
      subscribedEvents.push(
        {
          type: "message.part.updated",
          properties: {
            sessionID,
            part: {
              id: "current-part",
              messageID: "current-message",
              sessionID,
              type: "text",
              text: "Current response",
              time: { start: 3, end: 4 },
            },
          },
        },
        {
          type: "message.updated",
          properties: { sessionID, info: currentInfo },
        },
        {
          type: "question.asked",
          properties: { sessionID, id: "indexed-parts-barrier", questions: [] },
        },
      );
      runtimeMock.state.subscribedEvents = subscribedEvents;
      const values = Map.prototype.values;
      const spy = vi
        .spyOn(Map.prototype, "values")
        .mockImplementation(function (this: Map<unknown, unknown>) {
          const iterator = values.call(this);
          const next = iterator.next.bind(iterator);
          Object.defineProperty(iterator, "next", {
            value: () => {
              const result = next();
              const value: unknown = result.value;
              if (
                typeof value === "object" &&
                value !== null &&
                "id" in value &&
                typeof value.id === "string" &&
                value.id.startsWith("history-part-") &&
                countingHistoryVisits
              ) {
                visitedHistoryParts += 1;
              }
              return result;
            },
          });
          return iterator;
        });

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "user-input.requested" && event.requestId === "indexed-parts-barrier",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const events = yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second"));
      spy.mockRestore();
      NodeAssert.equal(visitedHistoryParts, 0);
      NodeAssert.deepEqual(
        events.flatMap((event) =>
          event.type === "content.delta" && event.itemId === "current-part"
            ? [event.payload.delta]
            : [],
        ),
        ["Current response"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps completed text edits and clears removed parts across reconnects", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-text-retention");
      const sessionID = "http://127.0.0.1:9999/session";
      const messageID = "retained-message";
      const metadata = {
        type: "message.updated",
        properties: {
          sessionID,
          info: { id: messageID, role: "assistant", time: { created: 1, completed: 2 } },
        },
      };
      const snapshot = (
        text: string,
        id = "retained-part",
        type: "text" | "reasoning" = "text",
      ) => ({
        type: "message.part.updated",
        properties: {
          sessionID,
          part: { id, sessionID, messageID, type, text, time: { start: 1, end: 2 } },
        },
      });
      const delta = (text: string) => ({
        type: "message.part.delta",
        properties: { sessionID, messageID, partID: "retained-part", field: "text", delta: text },
      });
      const nonTextReplacement = {
        type: "message.part.updated",
        properties: {
          sessionID,
          part: {
            id: "retained-part",
            sessionID,
            messageID,
            type: "file",
            mime: "text/plain",
            url: "file:///repo/result.txt",
          },
        },
      };
      runtimeMock.state.subscribedEvents = [
        snapshot("Replaced before metadata"),
        nonTextReplacement,
        metadata,
        snapshot("Thinking", "reasoning-part", "reasoning"),
        snapshot("Hello world"),
        { type: "server.connected", properties: {} },
        metadata,
        snapshot("Thinking", "reasoning-part", "reasoning"),
        snapshot("Thinking more", "reasoning-part", "reasoning"),
        snapshot("Hello world"),
        snapshot("Hello"),
        snapshot("Hello there"),
        delta(" again"),
        snapshot("Hello there again"),
        nonTextReplacement,
        delta("ignored while file"),
        metadata,
        snapshot("Hello there again!"),
        {
          type: "message.part.removed",
          properties: { sessionID, messageID, partID: "retained-part" },
        },
        delta("removed part"),
        metadata,
        snapshot("Fresh"),
        snapshot("Second", "second-part"),
        { type: "message.removed", properties: { sessionID, messageID } },
        delta("removed message"),
        metadata,
        snapshot("New thoughts", "reasoning-part", "reasoning"),
        snapshot("New"),
        {
          type: "question.asked",
          properties: { sessionID, id: "retention-barrier", questions: [] },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "user-input.requested" && event.requestId === "retention-barrier",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const events = yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second"));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => [event.payload.streamKind, event.payload.delta]),
        [
          ["reasoning_text", "Thinking"],
          ["assistant_text", "Hello world"],
          ["reasoning_text", " more"],
          ["assistant_text", "Hello"],
          ["assistant_text", " there"],
          ["assistant_text", " again"],
          ["assistant_text", "!"],
          ["assistant_text", "Fresh"],
          ["assistant_text", "Second"],
          ["reasoning_text", "New thoughts"],
          ["assistant_text", "New"],
        ],
      );
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.replaceExisting === true),
        [false, false, false, true, false, false, false, false, false, false, false],
      );
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "item.completed")
          .map((event) => event.payload.detail),
        ["Hello world", "Fresh", "Second", "New"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        Effect.gen(function* () {
          return yield* makeOpenCodeAdapter(openCodeAdapterTestSettings, {
            nativeEventLogger,
          });
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(session.threadId, "thread-native-log");
      assert.equal(nativeEvents.length, 1);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      assert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});

it.effect("OpenCodeAdapterLive stops active sessions when the adapter layer is released", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-finalizer"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(OpenCodeAdapterTestLayer)),
    );

    assert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
    assert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
  }),
);
