import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
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
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    createdSessionIds: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    abortSignals: [] as AbortSignal[],
    abortImplementation: null as
      | ((sessionID: string, signal?: AbortSignal) => Promise<void>)
      | null,
    sessionChildrenCalls: [] as string[],
    sessionChildrenById: new Map<string, Array<{ id: string }>>(),
    sessionChildrenImplementation: null as
      | ((sessionID: string) => Promise<Array<{ id: string }>>)
      | null,
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    messageCalls: [] as Array<{ sessionID: string; messageID: string }>,
    messageFailures: 0,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    promptAsyncImplementation: null as (() => Promise<void>) | null,
    autoPromptEcho: true,
    autoConnect: true,
    promptEchoEvents: [] as Array<unknown>,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as Array<unknown | Promise<unknown>>,
    eventSubscribeObserved: null as (() => void) | null,
    permissionReplyCalls: [] as Array<{ requestID: string; reply: string }>,
    permissionReplyImplementation: null as (() => Promise<void>) | null,
    questionReplyCalls: [] as Array<{
      requestID: string;
      answers: ReadonlyArray<ReadonlyArray<string>>;
    }>,
    sessionStatus: "idle" as "idle" | "busy",
    sessionStatusFailures: 0,
    sessionStatusCalls: 0,
    sessionStatusImplementation: null as (() => Promise<unknown>) | null,
    sessionGetIds: [] as string[],
    sessionGetObserved: null as ((sessionID: string) => void) | null,
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionParentById: new Map<string, string>(),
    pendingPermissions: [] as Array<PermissionRequest>,
    pendingQuestions: [] as Array<QuestionRequest>,
    permissionListCalls: 0,
    questionListCalls: 0,
    permissionListImplementation: null as (() => Promise<Array<PermissionRequest>>) | null,
    questionListImplementation: null as (() => Promise<Array<QuestionRequest>>) | null,
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.createdSessionIds.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.abortSignals.length = 0;
    this.state.abortImplementation = null;
    this.state.sessionChildrenCalls.length = 0;
    this.state.sessionChildrenById.clear();
    this.state.sessionChildrenImplementation = null;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.messageCalls.length = 0;
    this.state.messageFailures = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.promptAsyncImplementation = null;
    this.state.autoPromptEcho = true;
    this.state.autoConnect = true;
    this.state.promptEchoEvents.length = 0;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.eventSubscribeObserved = null;
    this.state.permissionReplyCalls.length = 0;
    this.state.permissionReplyImplementation = null;
    this.state.questionReplyCalls.length = 0;
    this.state.sessionStatus = "idle";
    this.state.sessionStatusFailures = 0;
    this.state.sessionStatusCalls = 0;
    this.state.sessionStatusImplementation = null;
    this.state.sessionGetIds.length = 0;
    this.state.sessionGetObserved = null;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionParentById.clear();
    this.state.pendingPermissions = [];
    this.state.pendingQuestions = [];
    this.state.permissionListCalls = 0;
    this.state.questionListCalls = 0;
    this.state.permissionListImplementation = null;
    this.state.questionListImplementation = null;
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword }) =>
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
        version: "1.15.13",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
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
        version: "1.15.13",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return {
            data: { id: runtimeMock.state.createdSessionIds.shift() ?? `${baseUrl}/session` },
          };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          runtimeMock.state.sessionGetObserved?.(sessionID);
          // The real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing → 404 throw, transient → 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          const parentID = runtimeMock.state.sessionParentById.get(sessionID);
          return {
            data: {
              id: sessionID,
              ...(directory ? { directory } : {}),
              ...(parentID ? { parentID } : {}),
            },
          };
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
        abort: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          if (options?.signal) {
            runtimeMock.state.abortSignals.push(options.signal);
          }
          await runtimeMock.state.abortImplementation?.(sessionID, options?.signal);
        },
        children: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionChildrenCalls.push(sessionID);
          return {
            data: runtimeMock.state.sessionChildrenImplementation
              ? await runtimeMock.state.sessionChildrenImplementation(sessionID)
              : (runtimeMock.state.sessionChildrenById.get(sessionID) ?? []),
          };
        },
        status: async () => {
          runtimeMock.state.sessionStatusCalls += 1;
          if (runtimeMock.state.sessionStatusImplementation) {
            return await runtimeMock.state.sessionStatusImplementation();
          }
          if (runtimeMock.state.sessionStatusFailures > 0) {
            runtimeMock.state.sessionStatusFailures -= 1;
            throw new Error("status failed");
          }
          return {
            data:
              runtimeMock.state.sessionStatus === "idle"
                ? {}
                : { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          await runtimeMock.state.promptAsyncImplementation?.();
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
          if (
            runtimeMock.state.autoPromptEcho &&
            typeof input === "object" &&
            input !== null &&
            "sessionID" in input &&
            "messageID" in input &&
            typeof input.sessionID === "string" &&
            typeof input.messageID === "string"
          ) {
            runtimeMock.state.messages.push({
              info: { id: input.messageID, role: "user" },
              parts: [],
            });
            runtimeMock.state.promptEchoEvents.push({
              id: `evt-auto-user-${input.messageID}`,
              type: "message.updated",
              properties: {
                sessionID: input.sessionID,
                info: { id: input.messageID, role: "user" },
              },
            });
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
          runtimeMock.state.messageCalls.push({ sessionID, messageID });
          if (runtimeMock.state.messageFailures > 0) {
            runtimeMock.state.messageFailures -= 1;
            throw new Error("message lookup failed", { cause: { status: 500 } });
          }
          const message = runtimeMock.state.messages.find((entry) => entry.info.id === messageID);
          if (!message) {
            throw new Error(`Message not found: ${messageID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          return { data: message };
        },
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => {
          runtimeMock.state.eventSubscribeObserved?.();
          return {
            stream: (async function* () {
              if (runtimeMock.state.autoConnect) {
                yield { id: "evt-auto-connected", type: "server.connected", properties: {} };
              }
              for (const event of runtimeMock.state.subscribedEvents) {
                const resolved = await event;
                while (runtimeMock.state.promptEchoEvents.length > 0) {
                  yield runtimeMock.state.promptEchoEvents.shift();
                }
                yield resolved;
              }
            })(),
          };
        },
      },
      permission: {
        list: async () => {
          runtimeMock.state.permissionListCalls += 1;
          return {
            data: runtimeMock.state.permissionListImplementation
              ? await runtimeMock.state.permissionListImplementation()
              : runtimeMock.state.pendingPermissions,
          };
        },
        reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
          runtimeMock.state.permissionReplyCalls.push({ requestID, reply });
          if (runtimeMock.state.permissionReplyImplementation) {
            await runtimeMock.state.permissionReplyImplementation();
          }
        },
      },
      question: {
        list: async () => {
          runtimeMock.state.questionListCalls += 1;
          return {
            data: runtimeMock.state.questionListImplementation
              ? await runtimeMock.state.questionListImplementation()
              : runtimeMock.state.pendingQuestions,
          };
        },
        reply: async ({
          requestID,
          answers,
        }: {
          requestID: string;
          answers: ReadonlyArray<ReadonlyArray<string>>;
        }) => {
          runtimeMock.state.questionReplyCalls.push({ requestID, answers });
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
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
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
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
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

beforeEach(() => {
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

function promiseWithResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const permissionRequest = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["pwd"],
  metadata: {},
  always: [],
});

const questionRequest = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [
    {
      header: "Scope",
      question: "Which scope should OpenCode use?",
      options: [{ label: "Workspace", description: "Use this workspace." }],
    },
  ],
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("fails startup when the OpenCode event stream does not connect", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-connect-timeout");
      runtimeMock.state.autoConnect = false;

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* advanceTestClock(10_000);

      const result = yield* Fiber.join(startFiber);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
      NodeAssert.equal(result.failure.method, "event.subscribe");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("closes a connecting session when startup is interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-connect-interrupted");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(startFiber);

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stops a connecting session and rejects its waiting send", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-connecting");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const connecting = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.equal(connecting?.status, "connecting");

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Must not be sent",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);

      yield* adapter.stopSession(threadId);
      const startResult = yield* Fiber.join(startFiber);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(startResult._tag, "Failure");
      NodeAssert.equal(sendResult._tag, "Failure");
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("aborts a held teardown request before closing the session scope", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-teardown-timeout");
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      yield* advanceTestClock(999);
      NodeAssert.equal(stopFiber.pollUnsafe(), undefined);
      NodeAssert.equal(runtimeMock.state.abortSignals.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, false);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

      yield* advanceTestClock(1);
      yield* Fiber.join(stopFiber);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, true);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stopAll closes a connecting session and releases startup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-all-connecting");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const sessionCount = (yield* adapter.listSessions()).length;

      yield* adapter.stopAll();
      const startResult = yield* Fiber.join(startFiber);
      NodeAssert.equal(startResult._tag, "Failure");
      NodeAssert.equal(runtimeMock.state.closeCalls.length, sessionCount);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("keeps one session when concurrent starts cross the connection barrier", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-concurrent-start");
      const connectionEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.createdSessionIds.push("ses_race_a", "ses_race_b");
      runtimeMock.state.subscribedEvents = [connectionEvent.promise];

      const firstStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      const secondStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      connectionEvent.resolve({
        id: "evt-concurrent-start-connected",
        type: "server.connected",
        properties: {},
      });

      const [firstSession, secondSession] = yield* Effect.all([
        Fiber.join(firstStart),
        Fiber.join(secondStart),
      ]);
      const sessions = yield* adapter.listSessions();
      const threadSessions = sessions.filter((session) => session.threadId === threadId);
      NodeAssert.equal(threadSessions.length, 1);
      NodeAssert.deepEqual(firstSession.resumeCursor, secondSession.resumeCursor);
      NodeAssert.equal(firstSession.status, "ready");
      NodeAssert.equal(secondSession.status, "ready");
      const winnerId = (threadSessions[0]?.resumeCursor as { sessionId?: string } | undefined)
        ?.sessionId;
      NodeAssert.ok(winnerId === "ses_race_a" || winnerId === "ses_race_b");
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        winnerId === "ses_race_a" ? "ses_race_b" : "ses_race_a",
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reuses a published connecting session after it becomes ready", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-reuse-connecting");
      const connectionEvent = promiseWithResolvers<unknown>();
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);
      runtimeMock.state.subscribedEvents = [connectionEvent.promise];

      const owningStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const reusedStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.sessionCreateUrls.length, 1);

      connectionEvent.resolve({
        id: "evt-reused-start-connected",
        type: "server.connected",
        properties: {},
      });
      const [ownedSession, reusedSession] = yield* Effect.all([
        Fiber.join(owningStart),
        Fiber.join(reusedStart),
      ]);
      NodeAssert.equal(ownedSession.status, "ready");
      NodeAssert.equal(reusedSession.status, "ready");
      NodeAssert.deepEqual(ownedSession.resumeCursor, reusedSession.resumeCursor);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not let an old held stop delete its replacement", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-old-stop-replacement");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.createdSessionIds.push("ses_old", "ses_replacement");

      const oldSession = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      const oldStop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      const replacement = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      NodeAssert.deepEqual(oldSession.resumeCursor, { schemaVersion: 1, sessionId: "ses_old" });
      NodeAssert.deepEqual(replacement.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_replacement",
      });

      abortRelease.resolve(undefined);
      yield* Fiber.join(oldStop);
      const current = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.deepEqual(current?.resumeCursor, replacement.resumeCursor);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("replaces a stopped connecting session while its teardown is held", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stopped-connecting-retry");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);
      runtimeMock.state.createdSessionIds.push("ses_connecting_old", "ses_connecting_replacement");

      const oldStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);

      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      const oldStop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      runtimeMock.state.autoConnect = true;
      runtimeMock.state.abortImplementation = null;
      const replacement = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      NodeAssert.equal(replacement.status, "ready");
      NodeAssert.deepEqual(replacement.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_connecting_replacement",
      });

      abortRelease.resolve(undefined);
      const oldStartResult = yield* Fiber.join(oldStart);
      yield* Fiber.join(oldStop);
      NodeAssert.equal(oldStartResult._tag, "Failure");
      const current = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.deepEqual(current?.resumeCursor, replacement.resumeCursor);

      yield* adapter.stopSession(threadId);
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

  it.effect("fails sendTurn for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-opencode-missing-send"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-send");
    }),
  );

  it.effect("fails stopSession for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .stopSession(asThreadId("thread-opencode-missing-stop"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-stop");
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [{ id: "ses_stop_child" }]);
      runtimeMock.state.sessionChildrenById.set("ses_stop_child", [{ id: "ses_stop_grandchild" }]);
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        rootSessionId,
        "ses_stop_child",
        "ses_stop_grandchild",
      ]);
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
      NodeAssert.deepEqual(
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

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
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
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
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

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("does not let an old idle status complete a successful steer", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-idle-admission");
      const busyBeforeSteer = promiseWithResolvers<unknown>();
      const idleBeforeSteer = promiseWithResolvers<unknown>();
      const idleAfterSteer = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        busyBeforeSteer.promise,
        idleBeforeSteer.promise,
        idleAfterSteer.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => {
        statusStarted.resolve(undefined);
        await statusRelease.promise;
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 3) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start the next turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyBeforeSteer.resolve({
        id: "evt-busy-before-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleBeforeSteer.resolve({
        id: "evt-idle-before-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add one more task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      statusRelease.resolve(undefined);
      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, activeTurn.turnId);

      idleAfterSteer.resolve({
        id: "evt-idle-after-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("waits for steer admission before accepting the only idle event", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-admission-only-idle");
      runtimeMock.state.autoPromptEcho = false;
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const staleIdleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        staleIdleEvent.promise,
        userMessageEvent.promise,
        idleEvent.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add another task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;
      NodeAssert.match(firstMessageId ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.match(steerMessageId ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      firstUserMessageEvent.resolve({
        id: "evt-delayed-first-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      staleIdleEvent.resolve({
        id: "evt-stale-idle-during-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      userMessageEvent.resolve({
        id: "evt-steer-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: steerMessageId, role: "user" },
        },
      });
      idleEvent.resolve({
        id: "evt-only-idle-during-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 0);
      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
    }),
  );

  it.effect("keeps steer admission until its user message arrives after prompt acceptance", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-message-after-acceptance");
      runtimeMock.state.autoPromptEcho = false;
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const staleIdleEvent = promiseWithResolvers<unknown>();
      const steerUserMessageEvent = promiseWithResolvers<unknown>();
      const validIdleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        staleIdleEvent.promise,
        steerUserMessageEvent.promise,
        validIdleEvent.promise,
      ];

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-message-before-steer",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Add another task",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;

      staleIdleEvent.resolve({
        id: "evt-stale-idle-after-steer-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      const sessionsAfterStaleIdle = yield* adapter.listSessions();
      const sessionAfterStaleIdle = sessionsAfterStaleIdle.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterStaleIdle?.status, "running");
      NodeAssert.equal(sessionAfterStaleIdle?.activeTurnId, activeTurn.turnId);

      steerUserMessageEvent.resolve({
        id: "evt-steer-user-message-after-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: steerMessageId, role: "user" },
        },
      });
      validIdleEvent.resolve({
        id: "evt-valid-idle-after-steer-message",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("recovers steer admission when reconnect happens before prompt acceptance", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-reconnect-before-acceptance");
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const reconnectEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [firstUserMessageEvent.promise, reconnectEvent.promise];
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-before-reconnect-steer",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;

      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add another task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;
      NodeAssert.ok(steerMessageId);
      runtimeMock.state.messages.push({
        info: { id: steerMessageId, role: "user" },
        parts: [],
      });
      runtimeMock.state.messageFailures = 1;
      reconnectEvent.resolve({
        id: "evt-reconnected-during-steer",
        type: "server.connected",
        properties: {},
      });
      yield* Effect.yieldNow;

      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(
        runtimeMock.state.messageCalls.filter((call) => call.messageID === steerMessageId).length,
        2,
      );
      const abortCallsAfterCompletion = runtimeMock.state.abortCalls.length;
      yield* adapter.interruptTurn(threadId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, abortCallsAfterCompletion);
    }),
  );

  it.effect("resolves admission without a prompt echo when busy and idle still arrive", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-admission-without-echo");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined;
        if (prompt?.messageID) {
          runtimeMock.state.messages.push({
            info: { id: prompt.messageID, role: "user" },
            parts: [],
          });
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run without an echo event",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-busy-without-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-idle-without-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* advanceTestClock(1_000);

      NodeAssert.equal(
        runtimeMock.state.messageCalls.some(
          (call) => call.messageID === runtimeMock.state.messages[0]?.info.id,
        ),
        true,
      );
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(turn.turnId !== undefined, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uses polled busy status to admit output after a stopped turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-polled-busy-after-stop");
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const assistantMessageEvent = promiseWithResolvers<unknown>();
      const assistantPartEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const busyStatusPolled = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        assistantMessageEvent.promise,
        assistantPartEvent.promise,
        idleEvent.promise,
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "content.delta" || event.type === "turn.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const stoppedMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-before-polled-busy-turn",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: stoppedMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      runtimeMock.state.sessionStatusCalls = 0;
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          busyStatusPolled.resolve(undefined);
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run without echo or busy events",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.promise(() => busyStatusPolled.promise);
      yield* Effect.yieldNow;

      assistantMessageEvent.resolve({
        id: "evt-assistant-after-polled-busy",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: "msg-assistant-after-polled-busy", role: "assistant" },
        },
      });
      assistantPartEvent.resolve({
        id: "evt-part-after-polled-busy",
        type: "message.part.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          part: {
            id: "part-after-polled-busy",
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-assistant-after-polled-busy",
            type: "text",
            text: "Visible output",
            time: { start: 1 },
          },
          time: 1,
        },
      });
      idleEvent.resolve({
        id: "evt-idle-after-polled-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["content.delta", "turn.completed"],
      );
      const delta = events[0];
      if (delta?.type === "content.delta") {
        NodeAssert.equal(delta.payload.delta, "Visible output");
      }
      NodeAssert.equal(events[1]?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a stale admission status response after the next turn starts", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-admission-status-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const staleStatusStarted = promiseWithResolvers<void>();
      const staleStatusRelease = promiseWithResolvers<void>();
      const staleStatusReturned = promiseWithResolvers<void>();
      const activePromptStarted = promiseWithResolvers<void>();
      const activePromptRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          staleStatusStarted.resolve(undefined);
          await staleStatusRelease.promise;
          staleStatusReturned.resolve(undefined);
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          activePromptStarted.resolve(undefined);
          await activePromptRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop while status is pending",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.promise(() => staleStatusStarted.promise);
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      const activeTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start while the old status is pending",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => activePromptStarted.promise);
      const activeMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;

      staleStatusRelease.resolve(undefined);
      yield* Effect.promise(() => staleStatusReturned.promise);
      for (let index = 0; index < 2; index += 1) {
        yield* Effect.yieldNow;
      }
      idleEvent.resolve({
        id: "evt-idle-after-stale-admission-status",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 4; index += 1) {
        yield* Effect.yieldNow;
      }
      NodeAssert.equal(activeTurnFiber.pollUnsafe(), undefined);
      NodeAssert.equal(completedFiber.pollUnsafe(), undefined);
      const sessionsBeforeAcceptance = yield* adapter.listSessions();
      const sessionBeforeAcceptance = sessionsBeforeAcceptance.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeAcceptance?.status, "running");
      NodeAssert.notEqual(sessionBeforeAcceptance?.activeTurnId, stoppedTurn.turnId);

      userMessageEvent.resolve({
        id: "evt-user-after-stale-admission-status",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      activePromptRelease.resolve(undefined);
      const activeTurn = yield* Fiber.join(activeTurnFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles a sole idle when the matching prompt echo arrives later", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-before-delayed-echo");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Finish before the echo arrives",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const messageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      idleEvent.resolve({
        id: "evt-idle-before-delayed-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      userMessageEvent.resolve({
        id: "evt-delayed-matching-echo",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: messageId, role: "user" },
        },
      });
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, turn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles the only idle after a stopped turn when the prompt echo is missing", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-only-without-echo-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined;
        if (prompt?.messageID) {
          runtimeMock.state.messages.push({
            info: { id: prompt.messageID, role: "user" },
            parts: [],
          });
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run after the stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const activeMessageId = (
        runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined
      )?.messageID;
      idleEvent.resolve({
        id: "evt-only-idle-without-echo-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* advanceTestClock(1_000);

      NodeAssert.equal(
        runtimeMock.state.messageCalls.some((call) => call.messageID === activeMessageId),
        true,
      );
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.notEqual(activeTurn.turnId, stoppedTurn.turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles a sole idle after a stop when the exact prompt echo arrives", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-before-exact-echo-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run after the stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const activeMessageId = (
        runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined
      )?.messageID;
      idleEvent.resolve({
        id: "evt-only-idle-before-exact-echo-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      const sessionsBeforeEcho = yield* adapter.listSessions();
      const sessionBeforeEcho = sessionsBeforeEcho.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeEcho?.status, "running");
      NodeAssert.equal(sessionBeforeEcho?.activeTurnId, activeTurn.turnId);

      userMessageEvent.resolve({
        id: "evt-exact-prompt-echo-after-stop",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers an idle before the exact prompt echo while acceptance is held", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-and-echo-before-acceptance-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const activePromptStarted = promiseWithResolvers<void>();
      const activePromptRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          activePromptStarted.resolve(undefined);
          await activePromptRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      const activeTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Run after the stop",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => activePromptStarted.promise);
      const activeMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;
      idleEvent.resolve({
        id: "evt-idle-before-held-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      userMessageEvent.resolve({
        id: "evt-exact-echo-before-held-prompt-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(activeTurnFiber.pollUnsafe(), undefined);

      activePromptRelease.resolve(undefined);
      const activeTurn = yield* Fiber.join(activeTurnFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores idle reconciliation after a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-failed-steer-idle");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const firstStatusStarted = promiseWithResolvers<void>();
      const firstStatusRelease = promiseWithResolvers<void>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          firstStatusStarted.resolve(undefined);
          await firstStatusRelease.promise;
        }
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 3) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
          throw new Error("steer failed");
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start the next turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-failed-steer-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-failed-steer-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => firstStatusStarted.promise);
      const steerFiber = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "This steer fails",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      firstStatusRelease.resolve(undefined);
      steerRelease.resolve(undefined);
      const steerExit = yield* Fiber.join(steerFiber);
      NodeAssert.equal(Exit.isFailure(steerExit), true);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 2);
    }),
  );

  it.effect("accepts the only idle event after a steer fails before creating its message", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-failed-steer-admission-idle");
      const idleEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
          throw new Error("steer failed before message creation");
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerFiber = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "This steer fails",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      idleEvent.resolve({
        id: "evt-idle-during-failed-admission",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      steerRelease.resolve(undefined);
      NodeAssert.equal(Exit.isFailure(yield* Fiber.join(steerFiber)), true);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("routes child-session approval requests and replies through the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-approval");
      const permissionReply = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-child-created",
          type: "session.created",
          properties: {
            sessionID: "ses_child",
            info: {
              id: "ses_child",
              parentID: "http://127.0.0.1:9999/session",
              title: "Child session",
            },
          },
        },
        {
          id: "evt-child-permission",
          type: "permission.asked",
          properties: {
            id: "per_child",
            sessionID: "ses_child",
            permission: "external_directory",
            patterns: ["/tmp/external/*"],
            metadata: { source: "child" },
            always: ["/tmp/external/*"],
          },
        },
        permissionReply.promise,
      ];

      const openedEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const openedEvents = Array.from(
        yield* Fiber.join(openedEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const opened = openedEvents.find((event) => event.type === "request.opened");
      NodeAssert.ok(opened);
      NodeAssert.equal(opened.requestId, "per_child");
      NodeAssert.equal(
        opened.raw?.source === "opencode.sdk.event" &&
          typeof opened.raw.payload === "object" &&
          opened.raw.payload !== null &&
          "properties" in opened.raw.payload
          ? (opened.raw.payload.properties as { sessionID?: string }).sessionID
          : undefined,
        "ses_child",
      );

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("per_child"),
        "acceptForSession",
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_child", reply: "always" },
      ]);

      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      permissionReply.resolve({
        id: "evt-child-permission-replied",
        type: "permission.replied",
        properties: {
          sessionID: "ses_child",
          requestID: "per_child",
          reply: "always",
        },
      });
      const resolved = yield* Fiber.join(resolvedEventFiber).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(Option.getOrUndefined(resolved)?.type, "request.resolved");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect.each([
    {
      name: "a doom-loop ask on the parent session",
      requestId: "per_doom_loop",
      sessionID: "http://127.0.0.1:9999/session",
      permission: "doom_loop",
      patterns: ["bash"],
      always: [] as string[],
    },
    {
      name: "a child-session ask",
      requestId: "per_child_full",
      sessionID: "ses_child_full",
      permission: "read",
      patterns: ["/repo/settings.env"],
      always: ["/repo/settings.env"],
    },
  ])(
    "auto-approves $name in full access",
    ({ requestId, sessionID, permission, patterns, always }) =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`thread-full-access-${requestId}`);
        runtimeMock.state.subscribedEvents = [
          {
            id: "evt-child-created",
            type: "session.created",
            properties: {
              sessionID: "ses_child_full",
              info: {
                id: "ses_child_full",
                parentID: "http://127.0.0.1:9999/session",
                title: "Child session",
              },
            },
          },
          {
            id: "evt-permission",
            type: "permission.asked",
            properties: { id: requestId, sessionID, permission, patterns, metadata: {}, always },
          },
          {
            id: "evt-permission-replied",
            type: "permission.replied",
            properties: { sessionID, requestID: requestId, reply: "once" },
          },
          // The suppressed ask emits nothing, so an empty question serves as a
          // sentinel that closes the collected stream once the pump is past it.
          {
            id: "evt-sentinel-question",
            type: "question.asked",
            properties: {
              id: "que_sentinel",
              sessionID: "http://127.0.0.1:9999/session",
              questions: [],
            },
          },
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "user-input.requested"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));

        NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
          { requestID: requestId, reply: "once" },
        ]);
        NodeAssert.equal(
          events.some((event) => event.type === "request.opened"),
          false,
        );
        NodeAssert.equal(
          events.some((event) => event.type === "request.resolved"),
          false,
        );

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("surfaces the approval when the full-access auto-reply fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-full-access-reply-failed");
      runtimeMock.state.permissionReplyImplementation = async () => {
        throw new Error("reply failed");
      };
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-doom-loop",
          type: "permission.asked",
          properties: {
            id: "per_doom_loop_failed",
            sessionID: "http://127.0.0.1:9999/session",
            permission: "doom_loop",
            patterns: ["bash"],
            metadata: {},
            always: [],
          },
        },
      ];

      const openedFiber = yield* adapter.streamEvents.pipe(
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
      const opened = Option.getOrUndefined(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened?.requestId, "per_doom_loop_failed");
      // Exactly one auto-reply attempt: the fallback surfaces the dialog
      // instead of retrying the reply.
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_doom_loop_failed", reply: "once" },
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not reopen a failed full-access auto-reply after its terminal reply", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-full-access-reply-failed-after-terminal");
      const childId = "ses_full_access_terminal_child";
      const request = permissionRequest("per_failed_after_terminal", childId);
      const ancestryAttempted = promiseWithResolvers<void>();
      const releaseReply = promiseWithResolvers<void>();
      // The ask arrives from a child whose ancestry lookup is failing, so it
      // is handled on a retry fiber. The terminal reply lands while that
      // fiber's auto-reply is still in flight; the reply then fails. The
      // request must neither reopen nor emit a stray resolution.
      runtimeMock.state.sessionParentById.set(childId, "http://127.0.0.1:9999/session");
      runtimeMock.state.transientErrorSessionIds.add(childId);
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === childId) {
          ancestryAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.permissionReplyImplementation = async () => {
        await releaseReply.promise;
        throw new Error("reply failed");
      };
      const terminalEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        { id: "evt-ask", type: "permission.asked", properties: request },
        terminalEvent.promise,
      ];

      const requestEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => ancestryAttempted.promise);
      runtimeMock.state.transientErrorSessionIds.delete(childId);
      yield* advanceTestClock(250);
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: request.id, reply: "once" },
      ]);

      // Drain the microtask queue so the pump has consumed the terminal reply
      // before the in-flight auto-reply is allowed to fail.
      terminalEvent.resolve({
        id: "evt-reply",
        type: "permission.replied",
        properties: { sessionID: childId, requestID: request.id, reply: "once" },
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      releaseReply.resolve(undefined);
      yield* advanceTestClock(250);

      NodeAssert.equal(requestEventsFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(requestEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes child-session questions and replies through the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-question");
      const questionReply = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-child-created",
          type: "session.created",
          properties: {
            sessionID: "ses_child_question",
            info: {
              id: "ses_child_question",
              parentID: "http://127.0.0.1:9999/session",
              title: "Child session",
            },
          },
        },
        {
          id: "evt-child-question",
          type: "question.asked",
          properties: {
            id: "que_child",
            sessionID: "ses_child_question",
            questions: [
              {
                header: "Scope",
                question: "Which scope should OpenCode use?",
                options: [{ label: "Workspace", description: "Use this workspace." }],
              },
            ],
          },
        },
        questionReply.promise,
      ];

      const requestedEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const requestedEvents = Array.from(
        yield* Fiber.join(requestedEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const requested = requestedEvents.find((event) => event.type === "user-input.requested");
      NodeAssert.ok(requested);
      NodeAssert.equal(requested.requestId, "que_child");

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("que_child"), {
        Scope: "Workspace",
      });
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: "que_child", answers: [["Workspace"]] },
      ]);

      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      questionReply.resolve({
        id: "evt-child-question-replied",
        type: "question.replied",
        properties: {
          sessionID: "ses_child_question",
          requestID: "que_child",
          answers: [["Workspace"]],
        },
      });
      const resolved = yield* Fiber.join(resolvedEventFiber).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(Option.getOrUndefined(resolved)?.type, "user-input.resolved");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers pending requests from existing nested child sessions on resume", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-resume-child-requests");
      runtimeMock.state.sessionParentById.set("ses_child", "ses_parent");
      runtimeMock.state.sessionParentById.set("ses_nested", "ses_child");
      runtimeMock.state.pendingPermissions = [permissionRequest("per_existing", "ses_nested")];
      runtimeMock.state.pendingQuestions = [questionRequest("que_existing", "ses_child")];

      const requestsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "user-input.requested"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });

      const requests = Array.from(
        yield* Fiber.join(requestsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.deepEqual(requests.map((event) => [event.type, event.requestId]).sort(), [
        ["request.opened", "per_existing"],
        ["user-input.requested", "que_existing"],
      ]);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("per_existing"), "accept");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("que_existing"), {
        Scope: "Workspace",
      });
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_existing", reply: "once" },
      ]);
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: "que_existing", answers: [["Workspace"]] },
      ]);
    }),
  );

  it.effect("retries ancestry for one live child request after a transient failure", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-request-ancestry-retry");
      const parentId = "http://127.0.0.1:9999/session";
      const ancestryAttempted = promiseWithResolvers<void>();
      runtimeMock.state.sessionParentById.set("ses_existing_child", parentId);
      runtimeMock.state.transientErrorSessionIds.add("ses_existing_child");
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === "ses_existing_child") {
          ancestryAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-existing-child-permission",
          type: "permission.asked",
          properties: permissionRequest("per_retry", "ses_existing_child"),
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" || event.type === "request.opened"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => ancestryAttempted.promise);
      runtimeMock.state.transientErrorSessionIds.delete("ses_existing_child");
      yield* advanceTestClock(250);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["runtime.warning", "request.opened"],
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("per_retry"), "accept");
    }),
  );

  it.effect("does not resurrect a recovered child request after its live reply", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-child-request-recovery");
      const listStarted = promiseWithResolvers<void>();
      const listRelease = promiseWithResolvers<void>();
      const stale = permissionRequest("per_stale", "ses_existing_child");
      runtimeMock.state.sessionParentById.set("ses_existing_child", "ses_parent");
      runtimeMock.state.permissionListImplementation = async () => {
        listStarted.resolve(undefined);
        await listRelease.promise;
        return [stale];
      };
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-stale-child-replied",
          type: "permission.replied",
          properties: {
            sessionID: "ses_existing_child",
            requestID: stale.id,
            reply: "once",
          },
        },
      ];

      const resolvedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });
      yield* Effect.promise(() => listStarted.promise);
      const resolved = Option.getOrUndefined(
        yield* Fiber.join(resolvedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(resolved?.type, "request.resolved");
      listRelease.resolve(undefined);
      yield* Effect.yieldNow;

      const response = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(stale.id), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(response), true);
    }),
  );

  it.effect("lets a child reply supersede an ask while ancestry lookup is retrying", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-terminal-during-ancestry");
      const ancestryAttempted = promiseWithResolvers<void>();
      const childId = "ses_terminal_child";
      const request = permissionRequest("per_terminal", childId);
      runtimeMock.state.sessionParentById.set(childId, "http://127.0.0.1:9999/session");
      runtimeMock.state.transientErrorSessionIds.add(childId);
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === childId) {
          ancestryAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-terminal-ask", type: "permission.asked", properties: request },
        {
          id: "evt-terminal-reply",
          type: "permission.replied",
          properties: { sessionID: childId, requestID: request.id, reply: "once" },
        },
      ];

      const terminalFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => ancestryAttempted.promise);
      runtimeMock.state.transientErrorSessionIds.delete(childId);
      yield* advanceTestClock(250);

      const terminal = Option.getOrUndefined(
        yield* Fiber.join(terminalFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(terminal?.type, "request.resolved");
      const response = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(response), true);
    }),
  );

  it.effect("caps terminal ancestry retries after a request finishes", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-terminal-ancestry-retry-cap");
      const childId = "ses_terminal_retry_cap_child";
      const request = permissionRequest("per_terminal_retry_cap", childId);
      const terminalEvent = promiseWithResolvers<unknown>();
      const askedAttempted = promiseWithResolvers<void>();
      const terminalAttempted = promiseWithResolvers<void>();
      let terminalReleased = false;
      runtimeMock.state.transientErrorSessionIds.add(childId);
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID !== childId) {
          return;
        }
        if (terminalReleased) {
          terminalAttempted.resolve(undefined);
        } else {
          askedAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-terminal-cap-ask", type: "permission.asked", properties: request },
        terminalEvent.promise,
      ];

      const unexpectedRequestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => askedAttempted.promise);
      const askedAttempts = runtimeMock.state.sessionGetIds.filter(
        (sessionID) => sessionID === childId,
      ).length;

      terminalReleased = true;
      terminalEvent.resolve({
        id: "evt-terminal-cap-reply",
        type: "permission.replied",
        properties: { sessionID: childId, requestID: request.id, reply: "once" },
      });
      yield* Effect.promise(() => terminalAttempted.promise);
      yield* advanceTestClock(10_000);
      const callsAfterCap = runtimeMock.state.sessionGetIds.filter(
        (sessionID) => sessionID === childId,
      ).length;
      NodeAssert.equal(callsAfterCap - askedAttempts, 5);

      yield* advanceTestClock(30_000);
      NodeAssert.equal(
        runtimeMock.state.sessionGetIds.filter((sessionID) => sessionID === childId).length,
        callsAfterCap,
      );
      NodeAssert.equal(unexpectedRequestFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(unexpectedRequestFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reruns recovery when the event stream connects during the startup snapshot", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-connected-recovery-rerun");
      const firstListStarted = promiseWithResolvers<void>();
      const firstListRelease = promiseWithResolvers<void>();
      const pending = permissionRequest("per_connected", "ses_existing_child");
      runtimeMock.state.sessionParentById.set("ses_existing_child", "ses_parent");
      runtimeMock.state.permissionListImplementation = async () => {
        if (runtimeMock.state.permissionListCalls === 1) {
          firstListStarted.resolve(undefined);
          await firstListRelease.promise;
          return [];
        }
        return [pending];
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-connected", type: "server.connected", properties: {} },
      ];

      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });
      yield* Effect.promise(() => firstListStarted.promise);
      firstListRelease.resolve(undefined);

      const opened = Option.getOrUndefined(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened?.requestId, pending.id);
      NodeAssert.equal(runtimeMock.state.permissionListCalls, 2);
    }),
  );

  it.effect("stops the full OpenCode child tree before it completes the interrupt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-child-tree");
      const parentAbortEvent = promiseWithResolvers<unknown>();
      const markerEvent = promiseWithResolvers<unknown>();
      const parentAbortStarted = promiseWithResolvers<void>();
      const parentAbortRelease = promiseWithResolvers<void>();
      const childAbortStarted = promiseWithResolvers<void>();
      const childAbortRelease = promiseWithResolvers<void>();
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [parentAbortEvent.promise, markerEvent.promise];
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [
        { id: "ses_child_a" },
        { id: "ses_child_b" },
      ]);
      runtimeMock.state.sessionChildrenById.set("ses_child_a", [{ id: "ses_grandchild" }]);
      runtimeMock.state.sessionChildrenById.set("ses_unrelated", [{ id: "ses_unrelated_child" }]);
      runtimeMock.state.abortImplementation = async (sessionID) => {
        if (sessionID === rootSessionId) {
          parentAbortStarted.resolve(undefined);
          await parentAbortRelease.promise;
        }
        if (sessionID === "ses_child_a") {
          childAbortStarted.resolve(undefined);
          await childAbortRelease.promise;
        }
      };

      const markerFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.threadId === threadId && event.type === "thread.metadata.updated",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run child agents",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => parentAbortStarted.promise);
      runtimeMock.state.sessionChildrenById.get(rootSessionId)?.push({ id: "ses_late_child" });
      parentAbortEvent.resolve({
        id: "evt-parent-aborted",
        type: "session.error",
        properties: {
          sessionID: rootSessionId,
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      markerEvent.resolve({
        id: "evt-after-parent-abort",
        type: "session.updated",
        properties: { info: { id: rootSessionId, title: "Parent abort received" } },
      });
      yield* Fiber.join(markerFiber);

      NodeAssert.equal(interruptFiber.pollUnsafe(), undefined);
      yield* Effect.promise(() => childAbortStarted.promise);
      NodeAssert.equal(interruptFiber.pollUnsafe(), undefined);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_unrelated"), false);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_unrelated_child"), false);
      const sessionsDuringCleanup = yield* adapter.listSessions();
      const sessionDuringCleanup = sessionsDuringCleanup.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionDuringCleanup?.status, "running");
      NodeAssert.equal(sessionDuringCleanup?.activeTurnId, turn.turnId);
      const nextTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start after every child stops",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      childAbortRelease.resolve(undefined);
      parentAbortRelease.resolve(undefined);
      const result = yield* Fiber.join(interruptFiber);
      const nextTurn = yield* Fiber.join(nextTurnFiber);
      NodeAssert.equal(result._tag, "Success");
      NodeAssert.notEqual(nextTurn.turnId, turn.turnId);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
      NodeAssert.equal(runtimeMock.state.abortCalls[0], rootSessionId);
      NodeAssert.deepEqual(
        new Set(runtimeMock.state.abortCalls.slice(1)),
        new Set(["ses_child_a", "ses_child_b", "ses_grandchild", "ses_late_child"]),
      );
      NodeAssert.deepEqual(
        new Set(runtimeMock.state.sessionChildrenCalls),
        new Set([rootSessionId, "ses_child_a", "ses_child_b", "ses_grandchild", "ses_late_child"]),
      );
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, nextTurn.turnId);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("limits SDK requests across the full OpenCode child tree", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-child-request-limit");
      const rootSessionId = "http://127.0.0.1:9999/session";
      const requestRelease = promiseWithResolvers<void>();
      const limitReached = promiseWithResolvers<void>();
      let inFlight = 0;
      let maxInFlight = 0;
      const holdRequest = async <T>(result: T): Promise<T> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 8) {
          limitReached.resolve(undefined);
        }
        await requestRelease.promise;
        inFlight -= 1;
        return result;
      };

      const children = Array.from({ length: 8 }, (_, index) => ({ id: `ses_child_${index}` }));
      runtimeMock.state.sessionChildrenById.set(rootSessionId, children);
      for (const child of children.slice(1)) {
        runtimeMock.state.sessionChildrenById.set(
          child.id,
          Array.from({ length: 8 }, (_, index) => ({ id: `${child.id}_nested_${index}` })),
        );
      }
      runtimeMock.state.abortImplementation = async (sessionID) => {
        if (sessionID.includes("_nested_")) {
          await holdRequest(undefined);
        }
      };
      runtimeMock.state.sessionChildrenImplementation = async (sessionID) => {
        if (sessionID === "ses_child_0") {
          return await holdRequest([]);
        }
        return runtimeMock.state.sessionChildrenById.get(sessionID) ?? [];
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run a nested child tree",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => limitReached.promise);
      yield* Effect.yieldNow;

      NodeAssert.equal(inFlight, 8);
      NodeAssert.equal(maxInFlight, 8);

      requestRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      runtimeMock.state.abortImplementation = null;
      runtimeMock.state.sessionChildrenImplementation = null;
      runtimeMock.state.sessionChildrenById.clear();
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("attempts every child abort and fails the interrupt when one child abort fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-child-failure");
      const rootSessionId = "http://127.0.0.1:9999/session";
      const failingChildStarted = promiseWithResolvers<void>();
      const failingChildRelease = promiseWithResolvers<void>();
      const siblingAbortStarted = promiseWithResolvers<void>();
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [
        { id: "ses_failing_child" },
        { id: "ses_surviving_sibling" },
      ]);
      runtimeMock.state.abortImplementation = async (sessionID) => {
        if (sessionID === "ses_failing_child") {
          failingChildStarted.resolve(undefined);
          await failingChildRelease.promise;
          throw new Error("child abort failed");
        }
        if (sessionID === "ses_surviving_sibling") {
          siblingAbortStarted.resolve(undefined);
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run child agents",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => failingChildStarted.promise);
      yield* Effect.promise(() => siblingAbortStarted.promise);
      NodeAssert.equal(interruptFiber.pollUnsafe(), undefined);
      failingChildRelease.resolve(undefined);
      const result = yield* Fiber.join(interruptFiber);

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(result.failure.detail, "child abort failed");
      }
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_failing_child"), true);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_surviving_sibling"), true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, turn.turnId);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps an idle event from completing a turn while its abort request is pending", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-idle-race");
      const idleEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
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
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      idleEvent.resolve({
        id: "evt-idle-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores late busy and idle status after an interrupted turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-late-status-after-interrupt");
      const lateBusy = promiseWithResolvers<unknown>();
      const lateIdle = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [lateBusy.promise, lateIdle.promise];

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
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);

      lateBusy.resolve({
        id: "evt-late-busy-after-interrupt",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      lateIdle.resolve({
        id: "evt-late-idle-after-interrupt",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );
    }),
  );

  it.effect("rejects a prompt accepted after its turn was interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-during-prompt-admission");
      const promptStarted = promiseWithResolvers<void>();
      const promptRelease = promiseWithResolvers<void>();
      const lateBusy = promiseWithResolvers<unknown>();
      const lateMessage = promiseWithResolvers<unknown>();
      const latePart = promiseWithResolvers<unknown>();
      const lateIdle = promiseWithResolvers<unknown>();
      const marker = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        lateBusy.promise,
        lateMessage.promise,
        latePart.promise,
        lateIdle.promise,
        marker.promise,
      ];
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 1) {
          promptStarted.resolve(undefined);
          await promptRelease.promise;
        }
      };

      const firstLateOutput = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "content.delta" || event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "This request is still pending",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => promptStarted.promise);

      yield* adapter.interruptTurn(threadId);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      const sessionsAfterStop = yield* adapter.listSessions();
      const sessionAfterStop = sessionsAfterStop.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterStop?.status, "ready");
      NodeAssert.equal(sessionAfterStop?.activeTurnId, undefined);

      promptRelease.resolve(undefined);
      const sendResult = yield* Fiber.join(sendFiber);
      lateBusy.resolve({
        id: "evt-busy-after-late-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      lateMessage.resolve({
        id: "evt-assistant-after-late-prompt-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: "msg-late-assistant", role: "assistant" },
        },
      });
      latePart.resolve({
        id: "evt-part-after-late-prompt-acceptance",
        type: "message.part.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          part: {
            id: "part-late-assistant",
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-late-assistant",
            type: "text",
            text: "Late output",
            time: { start: 1 },
          },
          time: 1,
        },
      });
      lateIdle.resolve({
        id: "evt-idle-after-late-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      marker.resolve({
        id: "evt-marker-after-late-prompt-acceptance",
        type: "session.updated",
        properties: {
          info: {
            id: "http://127.0.0.1:9999/session",
            title: "Late prompt cleaned up",
          },
        },
      });

      const firstOutput = Option.getOrUndefined(
        yield* Fiber.join(firstLateOutput).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(firstOutput?.type, "thread.metadata.updated");
      NodeAssert.equal(Exit.isFailure(sendResult), true);
      if (Exit.isFailure(sendResult)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendResult.cause), true);
      }

      yield* adapter.sendTurn({
        threadId,
        input: "Start after late cleanup",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      const sessionsAfterNextTurn = yield* adapter.listSessions();
      const sessionAfterNextTurn = sessionsAfterNextTurn.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterNextTurn?.status, "running");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("treats MessageAbortedError as the acknowledgment for a pending user stop", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-error-race");
      const abortedEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [abortedEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
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
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      abortedEvent.resolve({
        id: "evt-aborted-after-stop",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      yield* Effect.yieldNow;
      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => event.type),
        ["turn.aborted"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not claim a turn stopped when the abort request fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-request-failure");
      runtimeMock.state.abortImplementation = async () => {
        throw new Error("abort failed");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const exit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
      NodeAssert.equal(Exit.isFailure(exit), true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, turn.turnId);
    }),
  );

  it.effect("releases stop and send waiters when a native abort times out", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-timeout");
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };
      runtimeMock.state.sessionStatus = "busy";

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const unexpectedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" || event.type === "turn.aborted"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      const firstInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals.length, 1);
      const abortSignal = runtimeMock.state.abortSignals[0];
      const secondInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Wait for the stop request",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);

      yield* advanceTestClock(9_999);
      NodeAssert.equal(firstInterrupt.pollUnsafe(), undefined);
      NodeAssert.equal(secondInterrupt.pollUnsafe(), undefined);
      NodeAssert.equal(sendFiber.pollUnsafe(), undefined);
      yield* advanceTestClock(1);

      const firstResult = yield* Fiber.join(firstInterrupt);
      const secondResult = yield* Fiber.join(secondInterrupt);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(firstResult._tag, "Failure");
      NodeAssert.equal(secondResult._tag, "Failure");
      NodeAssert.equal(sendResult._tag, "Failure");
      if (firstResult._tag === "Failure") {
        NodeAssert.equal(firstResult.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(
          firstResult.failure.detail,
          "OpenCode session abort did not complete within 10 seconds.",
        );
      }
      NodeAssert.equal(abortSignal?.aborted, true);
      NodeAssert.equal(unexpectedEventFiber.pollUnsafe(), undefined);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.sendTurn({
        threadId,
        input: "Continue after the failed stop request",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);

      yield* Fiber.interrupt(unexpectedEventFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("shares one abort request across concurrent stops", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-concurrent-interrupt");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
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
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const firstInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      const secondInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);

      abortRelease.resolve(undefined);
      yield* Fiber.join(firstInterrupt);
      yield* Fiber.join(secondInterrupt);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("accepts a native turnless abort before its request times out", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-turnless-interrupt");
      const abortEvent = promiseWithResolvers<unknown>();
      const markerEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [abortEvent.promise, markerEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const acknowledgmentFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error" ||
              event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      const firstInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      const secondInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      runtimeMock.state.sessionStatusImplementation = async () => ({
        data: { ses_existing: { type: "busy" as const } },
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start after the session abort",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);

      abortEvent.resolve({
        id: "evt-turnless-abort",
        type: "session.error",
        properties: {
          sessionID: "ses_existing",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      markerEvent.resolve({
        id: "evt-after-turnless-abort",
        type: "session.updated",
        properties: {
          info: { id: "ses_existing", title: "Turnless abort acknowledged" },
        },
      });
      const acknowledgment = Option.getOrUndefined(yield* Fiber.join(acknowledgmentFiber));
      NodeAssert.equal(acknowledgment?.type, "thread.metadata.updated");
      const unexpectedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* advanceTestClock(10_000);
      yield* Fiber.join(firstInterrupt);
      yield* Fiber.join(secondInterrupt);
      yield* Fiber.join(sendFiber);

      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, true);
      NodeAssert.equal(unexpectedEventFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(unexpectedEventFiber);
      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a native turnless abort after its request succeeds", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-late-turnless-abort");
      const abortEvent = promiseWithResolvers<unknown>();
      const markerEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [abortEvent.promise, markerEvent.promise];

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const acknowledgmentFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error" ||
              event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(threadId);
      abortEvent.resolve({
        id: "evt-late-turnless-abort",
        type: "session.error",
        properties: {
          sessionID: "ses_existing",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      markerEvent.resolve({
        id: "evt-after-late-turnless-abort",
        type: "session.updated",
        properties: {
          info: { id: "ses_existing", title: "Late turnless abort ignored" },
        },
      });
      const acknowledgment = Option.getOrUndefined(yield* Fiber.join(acknowledgmentFiber));

      NodeAssert.equal(acknowledgment?.type, "thread.metadata.updated");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears a failed turnless interrupt before the next turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-turnless-interrupt-failure");
      runtimeMock.state.abortImplementation = async () => {
        throw new Error("abort failed");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const interruptExit = yield* Effect.exit(adapter.interruptTurn(threadId));
      NodeAssert.equal(Exit.isFailure(interruptExit), true);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.sendTurn({
        threadId,
        input: "Start after the failed session abort",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("waits for a pending stop before starting the next turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-send-during-stop");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const stopFiber = yield* adapter
        .interruptTurn(threadId, stoppedTurn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Second turn",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      abortRelease.resolve(undefined);
      yield* Fiber.join(stopFiber);
      const nextTurn = yield* Fiber.join(sendFiber);

      NodeAssert.notEqual(nextTurn.turnId, stoppedTurn.turnId);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("interrupts a turn waiting on cancellation when the session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-during-cancellation");
      const firstAbortStarted = promiseWithResolvers<void>();
      const teardownAbortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        if (runtimeMock.state.abortCalls.length === 1) {
          firstAbortStarted.resolve(undefined);
        } else {
          teardownAbortStarted.resolve(undefined);
        }
        await abortRelease.promise;
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const interruptFiber = yield* adapter
        .interruptTurn(threadId, activeTurn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstAbortStarted.promise);

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Must not be sent",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(Exit.isFailure(sendResult), true);
      if (Exit.isFailure(sendResult)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendResult.cause), true);
      }
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      yield* Effect.promise(() => teardownAbortStarted.promise);
      yield* advanceTestClock(1_000);
      yield* Fiber.join(stopFiber);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);

      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("rechecks a newer idle after an older status call returns busy", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-newer-idle-during-status");
      const busyEvent = promiseWithResolvers<unknown>();
      const staleIdle = promiseWithResolvers<unknown>();
      const realIdle = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, staleIdle.promise, realIdle.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          statusStarted.resolve(undefined);
          await statusRelease.promise;
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-new-turn-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      staleIdle.resolve({
        id: "evt-old-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      realIdle.resolve({
        id: "evt-new-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      statusRelease.resolve(undefined);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, secondTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 2);
    }),
  );

  it.effect("completes after transient status failures without another idle event", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-status-retry");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const failuresObserved = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls <= 2) {
          if (runtimeMock.state.sessionStatusCalls === 2) {
            failuresObserved.resolve(undefined);
          }
          throw new Error("status failed");
        }
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-retry-turn-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-retry-turn-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => failuresObserved.promise);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, secondTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 3);
    }),
  );

  it.effect("keeps idle reconciliation after a delayed abort from the stopped turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-abort-during-idle-check");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const staleAbortEvent = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        busyEvent.promise,
        idleEvent.promise,
        staleAbortEvent.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => {
        statusStarted.resolve(undefined);
        await statusRelease.promise;
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-stale-abort-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-stale-abort-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      staleAbortEvent.resolve({
        id: "evt-delayed-old-abort",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      statusRelease.resolve(undefined);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("keeps the newer turn running while status lookup keeps failing", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-status-permanent-failure");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const firstAttemptFailed = promiseWithResolvers<void>();
      const retryAttemptFailed = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 2) {
          firstAttemptFailed.resolve(undefined);
        }
        if (runtimeMock.state.sessionStatusCalls === 4) {
          retryAttemptFailed.resolve(undefined);
        }
        throw new Error("status remains unavailable");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-permanent-failure-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-permanent-failure-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => firstAttemptFailed.promise);
      yield* advanceTestClock(250);
      yield* Effect.promise(() => retryAttemptFailed.promise);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, activeTurn.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores delayed stop events around the next turn startup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-delayed-interrupt-events");
      const staleIdleBeforeBusy = promiseWithResolvers<unknown>();
      const nextBusy = promiseWithResolvers<unknown>();
      const nextUserMessage = promiseWithResolvers<unknown>();
      const staleAbort = promiseWithResolvers<unknown>();
      const staleIdle = promiseWithResolvers<unknown>();
      const secondStaleIdle = promiseWithResolvers<unknown>();
      const nextIdle = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        staleIdleBeforeBusy.promise,
        nextBusy.promise,
        nextUserMessage.promise,
        staleAbort.promise,
        staleIdle.promise,
        secondStaleIdle.promise,
        nextIdle.promise,
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const secondMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;

      staleIdleBeforeBusy.resolve({
        id: "evt-delayed-idle-before-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 2; index += 1) {
        yield* Effect.yieldNow;
      }
      const sessionsBeforeBusy = yield* adapter.listSessions();
      const sessionBeforeBusy = sessionsBeforeBusy.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeBusy?.status, "running");
      NodeAssert.equal(sessionBeforeBusy?.activeTurnId, secondTurn.turnId);

      runtimeMock.state.sessionStatus = "busy";
      nextBusy.resolve({
        id: "evt-next-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      nextUserMessage.resolve({
        id: "evt-next-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: secondMessageId, role: "user" },
        },
      });
      staleAbort.resolve({
        id: "evt-delayed-abort",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      staleIdle.resolve({
        id: "evt-delayed-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      secondStaleIdle.resolve({
        id: "evt-second-delayed-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 4; index += 1) {
        yield* Effect.yieldNow;
      }

      const sessionsBeforeRealIdle = yield* adapter.listSessions();
      const sessionBeforeRealIdle = sessionsBeforeRealIdle.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeRealIdle?.status, "running");
      NodeAssert.equal(sessionBeforeRealIdle?.activeTurnId, secondTurn.turnId);

      runtimeMock.state.sessionStatus = "idle";
      nextIdle.resolve({
        id: "evt-next-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => ({ type: event.type, turnId: event.turnId })),
        [
          { type: "turn.aborted", turnId: firstTurn.turnId },
          { type: "turn.completed", turnId: secondTurn.turnId },
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a genuine provider error visible during a pending user stop", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-provider-error");
      const errorEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const childAbortStarted = promiseWithResolvers<void>();
      const childAbortRelease = promiseWithResolvers<void>();
      const rootSessionId = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [errorEvent.promise];
      runtimeMock.state.sessionChildrenById.set(rootSessionId, [{ id: "ses_error_child" }]);
      runtimeMock.state.abortImplementation = async (sessionID) => {
        if (sessionID === rootSessionId) {
          abortStarted.resolve(undefined);
          await new Promise<void>(() => {});
        }
        if (sessionID === "ses_error_child") {
          childAbortStarted.resolve(undefined);
          await childAbortRelease.promise;
        }
      };

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
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      errorEvent.resolve({
        id: "evt-provider-error-after-stop",
        type: "session.error",
        properties: {
          sessionID: rootSessionId,
          error: {
            name: "APIError",
            data: { message: "Upstream failed", isRetryable: false },
          },
        },
      });
      yield* Effect.promise(() => childAbortStarted.promise);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => event.type),
        ["turn.completed", "runtime.error"],
      );
      const failed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        failed?.type === "turn.completed" ? failed.payload.state : undefined,
        "failed",
      );
      const sessionsDuringCleanup = yield* adapter.listSessions();
      const sessionDuringCleanup = sessionsDuringCleanup.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionDuringCleanup?.status, "error");
      NodeAssert.equal(sessionDuringCleanup?.activeTurnId, undefined);

      const secondInterruptFiber = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      const nextTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start after child cleanup",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(
        runtimeMock.state.abortCalls.filter((sessionID) => sessionID === rootSessionId).length,
        1,
      );
      NodeAssert.equal(secondInterruptFiber.pollUnsafe(), undefined);
      NodeAssert.equal(nextTurnFiber.pollUnsafe(), undefined);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      childAbortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(secondInterruptFiber);
      const nextTurn = yield* Fiber.join(nextTurnFiber);
      NodeAssert.notEqual(nextTurn.turnId, turn.turnId);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
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

      const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
        messageID: string;
        [key: string]: unknown;
      };
      NodeAssert.match(messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.deepEqual(prompt, {
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

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
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

      const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
        messageID: string;
        [key: string]: unknown;
      };
      NodeAssert.match(messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.deepEqual(prompt, {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
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

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
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
      const appendedUpdate = mergeOpenCodeAssistantText("Hello", "Hello world");
      const changedUpdate = mergeOpenCodeAssistantText("Hello world", "Hello there");
      const staleUpdate = mergeOpenCodeAssistantText("Hello world", "Hello");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
      NodeAssert.deepEqual(appendedUpdate, {
        latestText: "Hello world",
        deltaToEmit: " world",
      });
      NodeAssert.deepEqual(changedUpdate, {
        latestText: "Hello there",
        deltaToEmit: "there",
      });
      NodeAssert.deepEqual(staleUpdate, {
        latestText: "Hello world",
        deltaToEmit: "",
      });
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
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("lets OpenCode own session title generation and emits title metadata updates", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-sync");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate OpenCode title sync",
            },
          },
        },
      ];

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

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal("title" in (runtimeMock.state.sessionCreateInputs[0] ?? {}), false);

      const metadataUpdated = events.find((event) => event.type === "thread.metadata.updated");
      NodeAssert.ok(metadataUpdated);
      if (metadataUpdated.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated.payload.name, "Investigate OpenCode title sync");
      }
    }),
  );

  it.effect("passes the thread title to session.create when provided", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-provided");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        title: "Investigate reconnect failures",
      });

      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal(
        runtimeMock.state.sessionCreateInputs[0]?.title,
        "Investigate reconnect failures",
      );
    }),
  );

  it.effect("does not mirror OpenCode's default placeholder session titles", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-placeholder-title");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "New session - 2026-08-09T10:20:30.456Z",
            },
          },
        },
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate reconnect failures",
            },
          },
        },
      ];

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

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const metadataUpdated = events.filter((event) => event.type === "thread.metadata.updated");
      NodeAssert.equal(metadataUpdated.length, 1);
      if (metadataUpdated[0]?.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated[0].payload.name, "Investigate reconnect failures");
      }
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
          id: "evt-unrelated-child",
          type: "session.created",
          properties: {
            sessionID: "ses_unrelated_child",
            info: {
              id: "ses_unrelated_child",
              parentID: "ses_unrelated_parent",
              title: "Unrelated child",
            },
          },
        },
        {
          id: "evt-unrelated-permission",
          type: "permission.asked",
          properties: {
            id: "per_unrelated",
            sessionID: "ses_unrelated_child",
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        },
        {
          id: "evt-unrelated-question",
          type: "question.asked",
          properties: {
            id: "que_unrelated",
            sessionID: "ses_unrelated_child",
            questions: [],
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

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
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
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
