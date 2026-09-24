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
import type { FormDetail, OpenCodeEvent, PermissionRequest } from "@opencode/client";

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
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
} from "./OpenCodeAdapter.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

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
    revertMessageID: undefined as string | undefined,
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    messageCalls: [] as Array<{ sessionID: string; messageID: string }>,
    messageFailures: 0,
    promptCalls: [] as Array<unknown>,
    commandCalls: [] as Array<Record<string, unknown>>,
    commandImplementation: null as
      | ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<void>)
      | null,
    summarizeCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    promptAsyncImplementation: null as (() => Promise<void>) | null,
    autoPromptEcho: true,
    autoConnect: true,
    endEventStream: false,
    promptEchoEvents: [] as Array<unknown>,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    forkMessagesBySession: new Map<string, MessageEntry[]>(),
    forkPreservesBoundary: true,
    subscribedEvents: [] as Array<unknown | Promise<unknown>>,
    eventSubscribeObserved: null as (() => void) | null,
    eventStreamError: null as ((cause: unknown) => void) | null,
    permissionReplyCalls: [] as Array<{ requestID: string; reply: string }>,
    permissionReplyImplementation: null as ((signal?: AbortSignal) => Promise<void>) | null,
    permissionReplySignals: [] as AbortSignal[],
    questionReplyCalls: [] as Array<{
      requestID: string;
      answers: ReadonlyArray<ReadonlyArray<string>>;
    }>,
    questionReplyImplementation: null as ((signal?: AbortSignal) => Promise<void>) | null,
    sessionStatus: "idle" as "idle" | "busy",
    sessionStatusFailures: 0,
    sessionStatusCalls: 0,
    sessionStatusImplementation: null as (() => Promise<unknown>) | null,
    sessionGetIds: [] as string[],
    sessionGetObserved: null as ((sessionID: string) => void) | null,
    sessionGetImplementation: null as
      | ((sessionID: string, signal?: AbortSignal) => Promise<void>)
      | null,
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionParentById: new Map<string, string>(),
    pendingPermissions: [] as Array<PermissionRequest>,
    pendingQuestions: [] as Array<FormDetail>,
    permissionListCalls: 0,
    questionListCalls: 0,
    permissionListImplementation: null as (() => Promise<Array<PermissionRequest>>) | null,
    questionListImplementation: null as (() => Promise<Array<FormDetail>>) | null,
    sessionUpdateCalls: [] as Array<{ sessionID: string; permissions: unknown }>,
    sessionMoveCalls: [] as Array<{ sessionID: string; directory: string }>,
    forkCalls: [] as Array<{ sessionID: string; before?: string }>,
    agentList: [{ id: "build", name: "Build" }] as Array<{ id: string; name: string }>,
    switchAgentCalls: [] as Array<{ sessionID: string; agent: string }>,
    switchModelCalls: [] as Array<{ sessionID: string; model: unknown }>,
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
    this.state.revertMessageID = undefined;
    this.state.revertCalls.length = 0;
    this.state.messageCalls.length = 0;
    this.state.messageFailures = 0;
    this.state.promptCalls.length = 0;
    this.state.commandCalls.length = 0;
    this.state.commandImplementation = null;
    this.state.summarizeCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.promptAsyncImplementation = null;
    this.state.autoPromptEcho = true;
    this.state.autoConnect = true;
    this.state.endEventStream = false;
    this.state.promptEchoEvents.length = 0;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.forkMessagesBySession.clear();
    this.state.forkPreservesBoundary = true;
    this.state.subscribedEvents = [];
    this.state.eventSubscribeObserved = null;
    this.state.eventStreamError = null;
    this.state.permissionReplyCalls.length = 0;
    this.state.permissionReplyImplementation = null;
    this.state.permissionReplySignals.length = 0;
    this.state.questionReplyCalls.length = 0;
    this.state.questionReplyImplementation = null;
    this.state.sessionStatus = "idle";
    this.state.sessionStatusFailures = 0;
    this.state.sessionStatusCalls = 0;
    this.state.sessionStatusImplementation = null;
    this.state.sessionGetIds.length = 0;
    this.state.sessionGetObserved = null;
    this.state.sessionGetImplementation = null;
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
    this.state.sessionMoveCalls.length = 0;
    this.state.agentList = [{ id: "build", name: "Build" }];
    this.state.switchAgentCalls.length = 0;
    this.state.switchModelCalls.length = 0;
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
        version: "2.0.12",
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
        version: "2.0.12",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      command: {
        list: async () => ({
          data: [{ name: "review", source: "command", hints: ["$ARGUMENTS"] }],
        }),
      },
      agent: {
        list: async () => ({
          location: { directory: process.cwd() },
          data: runtimeMock.state.agentList,
        }),
      },
      message: {
        list: async ({ sessionID }: { sessionID: string }) => ({
          data: (
            runtimeMock.state.forkMessagesBySession.get(sessionID) ?? runtimeMock.state.messages
          ).map((entry) => ({ id: entry.info.id, type: entry.info.role, content: entry.parts })),
          cursor: {},
        }),
      },
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { id: runtimeMock.state.createdSessionIds.shift() ?? `${baseUrl}/session` };
        },
        get: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          runtimeMock.state.sessionGetObserved?.(sessionID);
          if (runtimeMock.state.sessionGetImplementation) {
            await runtimeMock.state.sessionGetImplementation(sessionID, options?.signal);
          }
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
            id: sessionID,
            ...(runtimeMock.state.revertMessageID &&
            !runtimeMock.state.forkMessagesBySession.has(sessionID)
              ? { revert: { messageID: runtimeMock.state.revertMessageID } }
              : {}),
            location: { directory: directory ?? process.cwd() },
            ...(parentID ? { parentID } : {}),
          };
        },
        update: async ({ sessionID, permissions }: { sessionID: string; permissions: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permissions });
          return { id: sessionID };
        },
        switchAgent: async ({ sessionID, agent }: { sessionID: string; agent: string }) => {
          runtimeMock.state.switchAgentCalls.push({ sessionID, agent });
        },
        switchModel: async ({ sessionID, model }: { sessionID: string; model: unknown }) => {
          runtimeMock.state.switchModelCalls.push({ sessionID, model });
        },
        move: async ({ sessionID, directory }: { sessionID: string; directory: string }) => {
          runtimeMock.state.sessionMoveCalls.push({ sessionID, directory });
        },
        wait: async () => undefined,
        instructions: { entry: { put: async () => undefined } },
        fork: async ({ sessionID, before }: { sessionID: string; before?: string }) => {
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(before ? { before } : {}) });
          const messages =
            runtimeMock.state.forkMessagesBySession.get(sessionID) ?? runtimeMock.state.messages;
          const boundary = before
            ? messages.findIndex((entry) => entry.info.id === before)
            : messages.length;
          NodeAssert.notEqual(boundary, -1);
          runtimeMock.state.forkMessagesBySession.set(
            forkedId,
            messages
              .slice(0, runtimeMock.state.forkPreservesBoundary ? boundary : messages.length)
              .map((entry) => ({ ...entry, info: { ...entry.info, id: `${entry.info.id}_fork` } })),
          );
          return { id: forkedId, location: { directory: process.cwd() } };
        },
        interrupt: async (
          { sessionID }: { sessionID: string },
          options?: { signal?: AbortSignal },
        ) => {
          runtimeMock.state.abortCalls.push(sessionID);
          if (options?.signal) {
            runtimeMock.state.abortSignals.push(options.signal);
          }
          await runtimeMock.state.abortImplementation?.(sessionID, options?.signal);
          runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions.filter(
            (request) => request.sessionID !== sessionID,
          );
          runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
            (request) => request.sessionID !== sessionID,
          );
        },
        list: async ({ parentID }: { parentID?: string }) => {
          const sessionID = parentID ?? "";
          runtimeMock.state.sessionChildrenCalls.push(sessionID);
          return {
            data: runtimeMock.state.sessionChildrenImplementation
              ? await runtimeMock.state.sessionChildrenImplementation(sessionID)
              : (runtimeMock.state.sessionChildrenById.get(sessionID) ?? []),
            cursor: {},
          };
        },
        active: async () => {
          runtimeMock.state.sessionStatusCalls += 1;
          if (runtimeMock.state.sessionStatusImplementation)
            return runtimeMock.state.sessionStatusImplementation();
          if (runtimeMock.state.sessionStatusFailures > 0) {
            runtimeMock.state.sessionStatusFailures -= 1;
            throw new Error("status failed");
          }
          return runtimeMock.state.sessionStatus === "idle"
            ? {}
            : { "http://127.0.0.1:9999/session": { type: "running" } };
        },
        command: async (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.commandCalls.push(input);
          await runtimeMock.state.commandImplementation?.(input, options?.signal);
        },
        prompt: async (input: unknown) => {
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
            "id" in input &&
            typeof input.sessionID === "string" &&
            typeof input.id === "string"
          ) {
            const messages =
              runtimeMock.state.forkMessagesBySession.get(input.sessionID) ??
              runtimeMock.state.messages;
            const text = "text" in input && typeof input.text === "string" ? input.text : "";
            messages.push({
              info: { id: input.id, role: "user" },
              parts: [],
            });
            runtimeMock.state.promptEchoEvents.push({
              id: `evt-auto-user-${input.id}`,
              type: "session.inbox.enqueued",
              created: 0,
              data: {
                sessionID: input.sessionID,
                inboxID: input.id,
                item: {
                  type: "user",
                  payload: { text },
                  delivery: "queue",
                },
              },
            });
          }
          return {
            id:
              typeof input === "object" &&
              input !== null &&
              "id" in input &&
              typeof input.id === "string"
                ? input.id
                : "inbox-generated",
            sessionID:
              typeof input === "object" &&
              input !== null &&
              "sessionID" in input &&
              typeof input.sessionID === "string"
                ? input.sessionID
                : "unknown-session",
            time: { created: 0 },
            type: "user",
            payload: {
              text:
                typeof input === "object" &&
                input !== null &&
                "text" in input &&
                typeof input.text === "string"
                  ? input.text
                  : "",
            },
            delivery: "queue",
          };
        },
        compact: async (input: unknown) => {
          runtimeMock.state.summarizeCalls.push(input);
        },
        message: {
          get: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
            runtimeMock.state.messageCalls.push({ sessionID, messageID });
            if (runtimeMock.state.messageFailures > 0) {
              runtimeMock.state.messageFailures -= 1;
              throw new Error("message lookup failed", { cause: { status: 500 } });
            }
            const messages =
              runtimeMock.state.forkMessagesBySession.get(sessionID) ?? runtimeMock.state.messages;
            const entry = messages.find((entry) => entry.info.id === messageID);
            if (!entry) throw new Error("Message not found", { cause: { status: 404 } });
            return { id: entry.info.id, type: entry.info.role, content: entry.parts };
          },
        },
        form: {
          list: async () => {
            runtimeMock.state.questionListCalls += 1;
            return runtimeMock.state.questionListImplementation
              ? await runtimeMock.state.questionListImplementation()
              : runtimeMock.state.pendingQuestions;
          },
          reply: async (
            { formID, answer }: { formID: string; answer: Record<string, unknown> },
            options?: { signal?: AbortSignal },
          ) => {
            runtimeMock.state.questionReplyCalls.push({
              requestID: formID,
              answers: [Object.values(answer).map(String)],
            });
            await runtimeMock.state.questionReplyImplementation?.(options?.signal);
            runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
              (request) => request.id !== formID,
            );
          },
        },
      },
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          runtimeMock.state.eventSubscribeObserved?.();
          return (async function* () {
            const aborted = promiseWithResolvers<void>();
            const onAbort = () => aborted.resolve(undefined);
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            try {
              if (runtimeMock.state.autoConnect) {
                yield { id: "evt-auto-connected", created: 0, type: "server.connected", data: {} };
              }
              for (const event of runtimeMock.state.subscribedEvents) {
                if (options?.signal?.aborted) return;
                const resolved = await Promise.race([event, aborted.promise]);
                if (options?.signal?.aborted) return;
                while (runtimeMock.state.promptEchoEvents.length > 0) {
                  yield runtimeMock.state.promptEchoEvents.shift();
                }
                const nativeEvent = resolved as OpenCodeEvent;
                if (nativeEvent.type === "permission.asked") {
                  runtimeMock.state.pendingPermissions =
                    runtimeMock.state.pendingPermissions.filter(
                      (request) => request.id !== nativeEvent.data.id,
                    );
                  runtimeMock.state.pendingPermissions.push(nativeEvent.data);
                } else if (nativeEvent.type === "permission.replied") {
                  runtimeMock.state.pendingPermissions =
                    runtimeMock.state.pendingPermissions.filter(
                      (request) => request.id !== nativeEvent.data.requestID,
                    );
                } else if (nativeEvent.type === "form.created") {
                  runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
                    (request) => request.id !== nativeEvent.data.form.id,
                  );
                  runtimeMock.state.pendingQuestions.push({
                    ...nativeEvent.data.form,
                    state: { status: "pending" },
                  });
                } else if (
                  nativeEvent.type === "form.replied" ||
                  nativeEvent.type === "form.cancelled"
                ) {
                  runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
                    (request) => request.id !== nativeEvent.data.id,
                  );
                }
                yield resolved;
              }
              if (!runtimeMock.state.endEventStream && !options?.signal?.aborted) {
                await aborted.promise;
              }
            } finally {
              options?.signal?.removeEventListener("abort", onAbort);
            }
          })();
        },
      },
      permission: {
        request: {
          list: async () => {
            runtimeMock.state.permissionListCalls += 1;
            return {
              location: { directory: process.cwd() },
              data: runtimeMock.state.permissionListImplementation
                ? await runtimeMock.state.permissionListImplementation()
                : runtimeMock.state.pendingPermissions,
            };
          },
        },
        list: async () => {
          runtimeMock.state.permissionListCalls += 1;
          return runtimeMock.state.permissionListImplementation
            ? await runtimeMock.state.permissionListImplementation()
            : runtimeMock.state.pendingPermissions;
        },
        reply: async (
          { requestID, decision }: { requestID: string; decision: string },
          options?: { signal?: AbortSignal },
        ) => {
          runtimeMock.state.permissionReplyCalls.push({ requestID, reply: decision });
          if (options?.signal) runtimeMock.state.permissionReplySignals.push(options.signal);
          if (runtimeMock.state.permissionReplyImplementation) {
            await runtimeMock.state.permissionReplyImplementation(options?.signal);
          }
          runtimeMock.state.pendingPermissions = runtimeMock.state.pendingPermissions.filter(
            (request) => request.id !== requestID,
          );
        },
      },
      form: {
        list: async () => {
          runtimeMock.state.questionListCalls += 1;
          return {
            location: { directory: process.cwd() },
            data: runtimeMock.state.questionListImplementation
              ? await runtimeMock.state.questionListImplementation()
              : runtimeMock.state.pendingQuestions,
          };
        },
        reply: async (
          {
            formID,
            answer,
          }: {
            formID: string;
            answer: Record<string, unknown>;
          },
          options?: { signal?: AbortSignal },
        ) => {
          runtimeMock.state.questionReplyCalls.push({
            requestID: formID,
            answers: [Object.values(answer).map(String)],
          });
          await runtimeMock.state.questionReplyImplementation?.(options?.signal);
          runtimeMock.state.pendingQuestions = runtimeMock.state.pendingQuestions.filter(
            (request) => request.id !== formID,
          );
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
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  recordImportedTranscript: () => Effect.die("unused"),
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

const makeLoggedOpenCodeAdapterLayer = (nativeEventLogger: EventNdjsonLogger) =>
  Layer.effect(
    OpenCodeAdapter,
    makeOpenCodeAdapter(openCodeAdapterTestSettings, { nativeEventLogger }),
  ).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
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
  action: "bash",
  resources: ["pwd"],
  metadata: {},
});

const formRequest = (id: string, sessionID: string): FormDetail => ({
  id,
  sessionID,
  title: "Scope",
  fields: [
    {
      key: "scope",
      type: "string",
      title: "Which scope should OpenCode use?",
      options: [{ value: "workspace", label: "Workspace", description: "Use this workspace." }],
    },
  ],
  state: { status: "pending" },
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
        created: 0,
        data: {},
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
        created: 0,
        data: {},
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
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permissions != null, true);

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
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permissions != null, true);

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
        NodeAssert.equal(typeof runtimeMock.state.sessionMoveCalls[0]?.directory, "string");
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

      NodeAssert.equal(runtimeMock.state.closeCalls.length >= 2, true);
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

  it.effect("admits a native command without waiting for a user-message receipt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-command-recovered");
      runtimeMock.state.commandImplementation = async (input) => {
        NodeAssert.equal(input.name, "review");
        NodeAssert.equal(input.text, "");
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const result = yield* adapter.sendTurn({
        threadId,
        input: "/review",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      NodeAssert.equal(runtimeMock.state.commandCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 0);
      NodeAssert.equal(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
          ?.activeTurnId,
        result.turnId,
      );
      yield* adapter.interruptTurn(threadId, result.turnId);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces native command rejection and leaves the session ready", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-command-error");
      runtimeMock.state.commandImplementation = async () => {
        throw new Error("command unavailable");
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "/review",
          modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        })
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") throw new Error("Unexpected error type");
      NodeAssert.equal(error.method, "session.command");
      NodeAssert.equal(error.detail, "command unavailable");
      NodeAssert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps unknown slash text on the ordinary prompt path", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-unknown-command");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "/unknown explain this",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      NodeAssert.equal(runtimeMock.state.commandCalls.length, 0);
      const prompt = runtimeMock.state.promptCalls[0] as { text: string };
      NodeAssert.equal(prompt.text, "/unknown explain this");
      yield* adapter.stopSession(threadId);
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
        "Provider adapter request failed (opencode) for session.prompt: prompt failed",
      );
      const session = sessions.find(
        (candidate) => candidate.threadId === asThreadId("thread-send-turn-failure"),
      );
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(session?.lastError, "prompt failed");
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

  it.effect("does not let an earlier completion complete a successful steer", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-idle-admission");
      const completionBeforeSteer = promiseWithResolvers<unknown>();
      const completionAfterSteer = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        completionBeforeSteer.promise,
        completionAfterSteer.promise,
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
      completionBeforeSteer.resolve({
        id: "evt-completion-before-steer",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* Effect.yieldNow;
      const nextTurn = yield* adapter.sendTurn({
        threadId,
        input: "Add one more task",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(nextTurn.turnId, activeTurn.turnId);

      completionAfterSteer.resolve({
        id: "evt-completion-after-steer",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, nextTurn.turnId);
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      idleEvent.resolve({
        id: "evt-idle-without-echo",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* advanceTestClock(1_000);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(turn.turnId !== undefined, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("marks subagents when a child is proven related by ancestry lookup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-ancestry-usage");
      // The child's `session.created` event was missed. Only the ancestry
      // lookup can prove that `ses_child` belongs to this thread.
      runtimeMock.state.sessionParentById.set("ses_child", "http://127.0.0.1:9999/session");
      runtimeMock.state.sessionStatus = "busy";
      const busy = promiseWithResolvers<unknown>();
      const childPermission = promiseWithResolvers<unknown>();
      const idle = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [busy.promise, childPermission.promise, idle.promise];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "turn.completed"),
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
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Delegate to a child",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      busy.resolve({
        id: "evt-child-ancestry-busy",
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* Fiber.join(sendFiber);

      const requestOpened = promiseWithResolvers<void>();
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === "ses_child") requestOpened.resolve(undefined);
      };
      childPermission.resolve({
        id: "evt-child-ancestry-permission",
        type: "permission.asked",
        created: 0,
        data: permissionRequest("per_child_ancestry", "ses_child"),
      });
      yield* Effect.promise(() => requestOpened.promise);
      yield* Effect.yieldNow;
      runtimeMock.state.sessionStatus = "idle";
      idle.resolve({
        id: "evt-child-ancestry-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.opened", "turn.completed"],
      );
      const completed = events[1];
      if (completed?.type === "turn.completed") {
        NodeAssert.deepEqual(completed.payload.tokenUsage, {
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: true,
        });
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps the new turn running when a stopped turn completes without a prompt echo", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-only-without-echo-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise];

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
      idleEvent.resolve({
        id: "evt-only-idle-without-echo-after-stop",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* advanceTestClock(1_000);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, activeTurn.turnId);
      NodeAssert.notEqual(activeTurn.turnId, stoppedTurn.turnId);

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
        return {};
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      idleEvent.resolve({
        id: "evt-failed-steer-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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
      runtimeMock.state.sessionStatusImplementation = async () => ({});
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
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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

  it.effect.each([
    { permission: "external_directory", decision: "accept", reply: "once" },
    { permission: "doom_loop", decision: "acceptForSession", reply: "always" },
    { permission: "todowrite", decision: "decline", reply: "reject" },
    { permission: "webfetch", decision: "cancel", reply: "reject" },
    { permission: "custom_tool", decision: "accept", reply: "once" },
  ] as const)(
    "shows $permission approval and resolves its $decision reply without SSE",
    ({ permission, decision, reply }) =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`thread-permission-${permission}`);
        const request = {
          ...permissionRequest(`per_${permission}`, "http://127.0.0.1:9999/session"),
          action: permission,
          resources: ["*"],
        };
        runtimeMock.state.subscribedEvents = [
          {
            id: "evt-permission",
            type: "permission.asked",
            created: 0,
            data: request,
          } satisfies OpenCodeEvent,
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
        });
        const opened = Option.getOrThrow(yield* Fiber.join(openedFiber));
        NodeAssert.ok(opened.type === "request.opened");
        NodeAssert.equal(opened.payload.requestType, "command_execution_approval");
        NodeAssert.equal(opened.payload.detail, permission.replaceAll("_", " "));
        NodeAssert.deepEqual(
          opened.payload.options?.map((option) => option.label),
          ["Allow once", "Allow for workspace", "Deny"],
        );
        const resolvedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.threadId === threadId && event.type === "request.resolved",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), decision);
        const resolved = Option.getOrThrow(yield* Fiber.join(resolvedFiber));
        NodeAssert.equal(resolved.requestId, request.id);
        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), decision);
        NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
          { requestID: request.id, reply },
        ]);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("keeps a permission reply retryable after its HTTP request times out", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-permission-timeout");
      const request = permissionRequest("per_timeout", "http://127.0.0.1:9999/session");
      const replyStarted = promiseWithResolvers<void>();
      runtimeMock.state.permissionReplyImplementation = async () => {
        replyStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-ask", type: "permission.asked", data: request },
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
      });
      yield* Fiber.join(openedFiber);
      const replyFiber = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept")
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => replyStarted.promise);
      yield* Effect.yieldNow;
      yield* advanceTestClock(10_000);
      NodeAssert.equal(Exit.isFailure(yield* Fiber.join(replyFiber)), true);
      NodeAssert.equal(runtimeMock.state.permissionReplySignals[0]?.aborted, true);
      runtimeMock.state.permissionReplyImplementation = null;
      const resolvedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.resolved"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept");
      NodeAssert.equal(Option.getOrThrow(yield* Fiber.join(resolvedFiber)).requestId, request.id);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a recovering permission retryable until its native request is loaded", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-permission-recovering");
      const request = permissionRequest("per_recovering", "ses_resumed");
      const listStarted = promiseWithResolvers<void>();
      const releaseList = promiseWithResolvers<PermissionRequest[]>();
      runtimeMock.state.permissionListImplementation = async () => {
        listStarted.resolve(undefined);
        return await releaseList.promise;
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: request.sessionID },
      });
      yield* Effect.promise(() => listStarted.promise);
      const reply = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept")
        .pipe(Effect.result);
      NodeAssert.equal(reply._tag, "Failure");
      if (reply._tag === "Failure" && reply.failure._tag === "ProviderAdapterRequestError") {
        NodeAssert.match(reply.failure.detail, /still loading/);
      }
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      releaseList.resolve([request]);
      yield* Fiber.join(openedFiber);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept");
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: request.id, reply: "once" },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps progress live during automatic approval and never reopens a finished turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-auto-approval-progress");
      const sessionID = "http://127.0.0.1:9999/session";
      const ask = promiseWithResolvers<unknown>();
      const idle = promiseWithResolvers<unknown>();
      const replyStarted = promiseWithResolvers<void>();
      const releaseReply = promiseWithResolvers<void>();
      runtimeMock.state.permissionReplyImplementation = async () => {
        replyStarted.resolve(undefined);
        await releaseReply.promise;
        throw new Error("reply response lost");
      };
      runtimeMock.state.subscribedEvents = [ask.promise, idle.promise];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      ask.resolve({
        id: "evt-ask",
        type: "permission.asked",
        created: 0,
        data: permissionRequest("per_slow_auto", sessionID),
      });
      yield* Effect.promise(() => replyStarted.promise);
      idle.resolve({
        id: "evt-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: { sessionID },
      });
      const completed = yield* Fiber.join(completedFiber);
      NodeAssert.equal(
        completed.some((event) => event.type === "request.opened"),
        false,
      );
      const remainingFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      releaseReply.resolve(undefined);
      yield* advanceTestClock(10_000);
      yield* adapter.stopSession(threadId);
      const remaining = yield* Fiber.join(remainingFiber);
      NodeAssert.equal(
        remaining.some((event) => event.type === "request.opened"),
        false,
      );
    }),
  );

  it.effect("keeps automatic approval fallback available after a steer", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-auto-approval-steer");
      const ask = promiseWithResolvers<unknown>();
      const replyStarted = promiseWithResolvers<void>();
      const releaseReply = promiseWithResolvers<void>();
      runtimeMock.state.sessionStatus = "busy";
      runtimeMock.state.permissionReplyImplementation = async () => {
        replyStarted.resolve(undefined);
        await releaseReply.promise;
        throw new Error("reply failed");
      };
      runtimeMock.state.subscribedEvents = [ask.promise];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("opencode"),
        "opencode/kimi-k3",
      );
      const turn = yield* adapter.sendTurn({ threadId, input: "Work", modelSelection });
      ask.resolve({
        id: "evt-ask",
        type: "permission.asked",
        created: 0,
        data: permissionRequest("per_steer_auto", "http://127.0.0.1:9999/session"),
      });
      yield* Effect.promise(() => replyStarted.promise);
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "Keep the change small",
        modelSelection,
      });
      NodeAssert.equal(steered.turnId, turn.turnId);
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      releaseReply.resolve(undefined);
      NodeAssert.equal(
        Option.getOrThrow(yield* Fiber.join(openedFiber)).requestId,
        "per_steer_auto",
      );
      runtimeMock.state.permissionReplyImplementation = null;
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("per_steer_auto"), "accept");
      yield* adapter.stopSession(threadId);
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
          created: 0,
          durable: { aggregateID: "ses_child", seq: 1, version: 1 },
          data: {
            sessionID: "ses_child",
            projectID: "project",
            location: { directory: process.cwd() },
            parentID: "http://127.0.0.1:9999/session",
            slug: "child-session",
            title: "Child session",
            version: "2",
          },
        },
        {
          id: "evt-child-permission",
          type: "permission.asked",
          created: 0,
          data: {
            id: "per_child",
            sessionID: "ses_child",
            action: "external_directory",
            resources: ["/tmp/external/*"],
            metadata: { source: "child" },
          },
        },
        permissionReply.promise,
      ];

      const openedEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const opened = Option.getOrThrow(
        yield* Fiber.join(openedEventsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened.requestId, "per_child");
      NodeAssert.equal(
        opened.raw?.source === "opencode.sdk.event" &&
          typeof opened.raw.payload === "object" &&
          opened.raw.payload !== null &&
          "data" in opened.raw.payload
          ? (opened.raw.payload.data as { sessionID?: string }).sessionID
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
        created: 0,
        data: {
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
          created: 0,
          data: {
            id: "per_doom_loop_failed",
            sessionID: "http://127.0.0.1:9999/session",
            action: "doom_loop",
            resources: ["bash"],
            metadata: {},
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
        { id: "evt-ask", type: "permission.asked", data: request },
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
        created: 0,
        data: { sessionID: childId, requestID: request.id, reply: "once" },
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      releaseReply.resolve(undefined);
      yield* advanceTestClock(250);

      NodeAssert.equal(requestEventsFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(requestEventsFiber);
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
      runtimeMock.state.pendingQuestions = [formRequest("que_existing", "ses_child")];

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
        scope: "Workspace",
      });
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_existing", reply: "once" },
      ]);
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: "que_existing", answers: [["workspace"]] },
      ]);
    }),
  );

  it.effect.each(["failure", "timeout"] as const)(
    "retries ancestry for a child request after a transient %s",
    (lookupFailure) =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId(`thread-child-request-ancestry-retry-${lookupFailure}`);
        const parentId = "http://127.0.0.1:9999/session";
        const ancestryAttempted = promiseWithResolvers<void>();
        runtimeMock.state.sessionParentById.set("ses_existing_child", parentId);
        runtimeMock.state.transientErrorSessionIds.add("ses_existing_child");
        let lookupSignal: AbortSignal | undefined;
        if (lookupFailure === "timeout") {
          runtimeMock.state.sessionGetImplementation = async (_sessionID, signal) => {
            lookupSignal = signal;
            await new Promise<void>(() => {});
          };
        }
        runtimeMock.state.sessionGetObserved = (sessionID) => {
          if (sessionID === "ses_existing_child") {
            ancestryAttempted.resolve(undefined);
          }
        };
        runtimeMock.state.subscribedEvents = [
          {
            id: "evt-existing-child-permission",
            type: "permission.asked",
            created: 0,
            data: permissionRequest("per_retry", "ses_existing_child"),
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
        if (lookupFailure === "timeout") {
          yield* Effect.yieldNow;
          yield* advanceTestClock(10_000);
          NodeAssert.equal(lookupSignal?.aborted, true);
          runtimeMock.state.sessionGetImplementation = null;
        }
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
          created: 0,
          data: {
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
      NodeAssert.equal(Exit.isSuccess(response), true);
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, []);
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
        { id: "evt-terminal-ask", type: "permission.asked", data: request },
        {
          id: "evt-terminal-reply",
          type: "permission.replied",
          created: 0,
          data: { sessionID: childId, requestID: request.id, reply: "once" },
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
      NodeAssert.equal(Exit.isSuccess(response), true);
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, []);
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
        { id: "evt-terminal-cap-ask", type: "permission.asked", data: request },
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
        created: 0,
        data: { sessionID: childId, requestID: request.id, reply: "once" },
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
        { id: "evt-connected", type: "server.connected", data: {} },
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
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      lateIdle.resolve({
        id: "evt-late-idle-after-interrupt",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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

  it.effect("treats execution.interrupted as the acknowledgment for a pending user stop", () =>
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
        type: "session.execution.interrupted",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
          reason: "user",
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
          return { "http://127.0.0.1:9999/session": { type: "running" as const } };
        }
        return {};
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      staleIdle.resolve({
        id: "evt-old-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      realIdle.resolve({
        id: "evt-new-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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
        if (runtimeMock.state.sessionStatusCalls <= 1) {
          if (runtimeMock.state.sessionStatusCalls === 1) {
            failuresObserved.resolve(undefined);
          }
          throw new Error("status failed");
        }
        return {};
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      idleEvent.resolve({
        id: "evt-retry-turn-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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
        return {};
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      idleEvent.resolve({
        id: "evt-stale-abort-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      staleAbortEvent.resolve({
        id: "evt-delayed-old-abort",
        type: "session.execution.interrupted",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
          reason: "user",
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
        if (runtimeMock.state.sessionStatusCalls === 1) {
          firstAttemptFailed.resolve(undefined);
        }
        if (runtimeMock.state.sessionStatusCalls === 2) {
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
        type: "session.execution.started",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
        },
      });
      idleEvent.resolve({
        id: "evt-permanent-failure-idle",
        type: "session.execution.succeeded",
        created: 0,
        data: {
          sessionID: "http://127.0.0.1:9999/session",
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
        type: "session.execution.failed",
        created: 0,
        data: {
          sessionID: rootSessionId,
          error: {
            type: "api",
            message: "Upstream failed",
            retryable: false,
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
      const startedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started"),
        Stream.runHead,
        Effect.forkChild,
      );
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

      const { id, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
        id: string;
        [key: string]: unknown;
      };
      NodeAssert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.deepEqual(prompt, {
        sessionID: "http://127.0.0.1:9999/session",
        text: "Fix it",
        files: [],
      });
      NodeAssert.deepEqual(runtimeMock.state.switchModelCalls.at(-1)?.model, {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
        variant: "high",
      });
      NodeAssert.equal(runtimeMock.state.switchAgentCalls.at(-1)?.agent, "github-copilot");
      const started = yield* Fiber.join(startedFiber);
      NodeAssert.equal(started._tag, "Some");
      if (started._tag === "Some" && started.value.type === "turn.started") {
        NodeAssert.equal(started.value.payload.effort, undefined);
      }
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

      const { id, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
        id: string;
        [key: string]: unknown;
      };
      NodeAssert.match(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.deepEqual(prompt, {
        sessionID: "http://127.0.0.1:9999/session",
        text: "Fix it",
        files: [],
      });
      NodeAssert.deepEqual(runtimeMock.state.switchModelCalls.at(-1)?.model, {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
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

  it.effect("forks before the removed user prompt and resumes only retained history", () =>
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

      const originalCursor = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      )?.resumeCursor;
      runtimeMock.state.forkPreservesBoundary = false;
      const boundaryError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      NodeAssert.match(boundaryError.message, /did not preserve the requested rewind boundary/);
      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
          ?.resumeCursor,
        originalCursor,
      );
      runtimeMock.state.forkPreservesBoundary = true;

      for (const numTurns of [0, 1, 2, 3]) {
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        runtimeMock.state.forkCalls.length = 0;
        const snapshot = yield* adapter.rollbackThread(threadId, numTurns);
        NodeAssert.deepEqual(
          runtimeMock.state.forkCalls.map(({ sessionID, before }) => ({ sessionID, before })),
          numTurns === 0
            ? []
            : [
                {
                  sessionID: "http://127.0.0.1:9999/session",
                  before: numTurns === 1 ? "user-2" : "user-1",
                },
              ],
        );
        NodeAssert.deepEqual(
          snapshot.turns.map((turn) => turn.id),
          numTurns === 0
            ? ["assistant-1", "assistant-2"]
            : ["assistant-1_fork"].slice(0, Math.max(0, 2 - numTurns)),
        );
        NodeAssert.deepEqual(runtimeMock.state.revertCalls, []);
      }
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      for (const remaining of [1, 0]) {
        const snapshot = yield* adapter.rollbackThread(threadId, 1);
        NodeAssert.equal(snapshot.turns.length, remaining);
        NodeAssert.deepEqual((yield* adapter.readThread(threadId)).turns, snapshot.turns);
        const cursor = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        )?.resumeCursor;
        NodeAssert.deepEqual(cursor, {
          schemaVersion: 1,
          sessionId:
            remaining === 1
              ? "http://127.0.0.1:9999/session_fork"
              : "http://127.0.0.1:9999/session_fork_fork",
        });
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access", resumeCursor: cursor });
        NodeAssert.deepEqual((yield* adapter.readThread(threadId)).turns, snapshot.turns);
      }
      NodeAssert.deepEqual(
        runtimeMock.state.forkCalls.slice(-2).map((call) => call.before),
        ["user-2", "user-1_fork"],
      );
      yield* adapter.sendTurn({
        threadId,
        input: "continue the retained conversation",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/claude-sonnet-4-5",
        ),
      });
      NodeAssert.equal(
        (runtimeMock.state.promptCalls.at(-1) as { sessionID: string }).sessionID,
        "http://127.0.0.1:9999/session_fork_fork",
      );
      const continuation = runtimeMock.state.promptCalls.at(-1) as {
        sessionID: string;
        id: string;
      };
      runtimeMock.state.forkMessagesBySession.get(continuation.sessionID)!.push({
        info: { id: "continuation-answer", role: "assistant" },
        parts: [{ id: "continuation-part", type: "text", text: "continued answer" }],
      });
      const continuationCursor = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      )?.resumeCursor;
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: continuationCursor,
      });
      NodeAssert.deepEqual(
        (yield* adapter.readThread(threadId)).turns.map((turn) => turn.id),
        ["continuation-answer"],
      );
      NodeAssert.deepEqual((yield* adapter.rollbackThread(threadId, 1)).turns, []);
      NodeAssert.equal(runtimeMock.state.forkCalls.at(-1)?.before, continuation.id);
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      runtimeMock.state.messages = runtimeMock.state.messages.filter(
        (entry) => entry.info.id !== "user-2",
      );
      const sharedUserSnapshot = yield* adapter.rollbackThread(threadId, 1);
      NodeAssert.equal(runtimeMock.state.forkCalls.at(-1)?.before, "user-1");
      NodeAssert.deepEqual(sharedUserSnapshot.turns, []);
      NodeAssert.deepEqual((yield* adapter.readThread(threadId)).turns, []);

      runtimeMock.state.messages = [];
      runtimeMock.state.forkCalls.length = 0;
      const emptySnapshot = yield* adapter.rollbackThread(threadId, 1);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(emptySnapshot.turns, []);
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

  it.effect.skipIf(!symlinksSupported)(
    "treats lexically or physically identical directories as the same",
    () =>
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

  it.effect("recovers a completion missed during reconnect", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-reconnect-completion");
      const reconnect = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [reconnect.promise];
      runtimeMock.state.sessionStatus = "busy";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      runtimeMock.state.sessionStatus = "idle";
      reconnect.resolve({
        id: "evt-reconnected",
        type: "server.connected",
        data: {},
      } satisfies OpenCodeEvent);
      NodeAssert.equal(Option.getOrThrow(yield* Fiber.join(completedFiber)).turnId, turn.turnId);
      NodeAssert.equal(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
        "ready",
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "ends a running session on clean stream closure without discarding unresolved permissions",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-stream-closed");
        const endStream = promiseWithResolvers<unknown>();
        const request = permissionRequest("per_disconnect", "http://127.0.0.1:9999/session");
        runtimeMock.state.pendingPermissions = [request];
        runtimeMock.state.subscribedEvents = [endStream.promise];
        const openedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
          Stream.runHead,
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "approval-required",
        });
        yield* Fiber.join(openedFiber);
        yield* adapter.sendTurn({
          threadId,
          input: "Work",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        const exitedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        runtimeMock.state.endEventStream = true;
        runtimeMock.state.abortImplementation = async () => {
          throw new Error("server unreachable");
        };
        endStream.resolve({
          id: "evt-busy",
          type: "session.execution.started",
          created: 0,
          data: { sessionID: request.sessionID },
        });
        const exited = yield* Fiber.join(exitedFiber);
        NodeAssert.equal(
          exited.some((event) => event.type === "request.resolved"),
          false,
        );
        NodeAssert.match(
          exited.find((event) => event.type === "runtime.error")?.payload.message ?? "",
          /event stream ended/,
        );
        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
        runtimeMock.state.endEventStream = false;
        runtimeMock.state.subscribedEvents = [];
        runtimeMock.state.abortImplementation = null;
        const recoveredFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: session.resumeCursor,
        });
        NodeAssert.equal(
          Option.getOrThrow(yield* Fiber.join(recoveredFiber)).requestId,
          request.id,
        );
        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept");
        yield* adapter.stopSession(threadId);
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

  it.effect("restores the configured default agent after a plan turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-default-agent-after-plan");
      runtimeMock.state.agentList = [{ id: "custom-default", name: "Custom default" }];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("opencode"),
        "anthropic/claude-sonnet-4-5",
      );
      yield* adapter.sendTurn({
        threadId,
        input: "Plan this",
        interactionMode: "plan",
        modelSelection,
      });
      yield* adapter.sendTurn({ threadId, input: "Implement it", modelSelection });
      NodeAssert.deepEqual(
        runtimeMock.state.switchAgentCalls.map((call) => call.agent),
        ["plan", "custom-default"],
      );
    }),
  );

  it.effect("preserves the selected variant when compacting", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-compact-variant");
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("opencode"),
        "anthropic/claude-sonnet-4-5",
        [{ id: "variant", value: "high" }],
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection,
      });
      NodeAssert.ok(adapter.compaction?.type === "native");
      yield* adapter.compaction.start(threadId, modelSelection);
      NodeAssert.deepEqual(runtimeMock.state.switchModelCalls.at(-1)?.model, {
        providerID: "anthropic",
        id: "claude-sonnet-4-5",
        variant: "high",
      });
    }),
  );

  it.effect("streams native text and reasoning deltas with final token usage", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-deltas");
      const text = promiseWithResolvers<unknown>();
      const reasoning = promiseWithResolvers<unknown>();
      const step = promiseWithResolvers<unknown>();
      const succeeded = promiseWithResolvers<unknown>();
      const sessionID = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [
        {
          id: "step-started",
          created: 1,
          type: "session.step.started",
          durable: { aggregateID: sessionID, seq: 1, version: 1 },
          data: {
            sessionID,
            assistantMessageID: "msg",
            agent: "build",
            model: { providerID: "openai", id: "gpt-5" },
            started: 1,
          },
        } satisfies OpenCodeEvent,
        text.promise,
        reasoning.promise,
        step.promise,
        succeeded.promise,
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
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
        input: "Say hi",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      text.resolve({
        id: "text",
        created: 1,
        type: "session.text.delta",
        data: { sessionID, assistantMessageID: "msg", ordinal: 0, delta: "Hello" },
      } satisfies OpenCodeEvent);
      reasoning.resolve({
        id: "reasoning",
        created: 2,
        type: "session.reasoning.delta",
        data: { sessionID, assistantMessageID: "msg", ordinal: 0, delta: "Think" },
      } satisfies OpenCodeEvent);
      step.resolve({
        id: "step",
        created: 3,
        type: "session.step.ended",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "msg",
          finish: "stop",
          cost: 0,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      } satisfies OpenCodeEvent);
      succeeded.resolve({
        id: "done",
        created: 4,
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionID, seq: 3, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) =>
            event.type === "content.delta"
              ? [event.payload.streamKind, event.payload.delta]
              : undefined,
          ),
        [
          ["assistant_text", "Hello"],
          ["reasoning_text", "Think"],
        ],
      );
      const completed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(completed?.turnId, turn.turnId);
      if (completed?.type === "turn.completed")
        NodeAssert.deepEqual(completed.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 14,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          outputTokens: 7,
          reasoningTokens: 2,
          hasSubagents: false,
        });
    }),
  );

  it.effect("does not charge a replayed step to the next native turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-replayed-step-usage");
      const firstStarted = promiseWithResolvers<unknown>();
      const firstSucceeded = promiseWithResolvers<unknown>();
      const secondStarted = promiseWithResolvers<unknown>();
      const replayedFirstStep = promiseWithResolvers<unknown>();
      const secondStep = promiseWithResolvers<unknown>();
      const secondSucceeded = promiseWithResolvers<unknown>();
      const firstCompletionSignal = promiseWithResolvers<void>();
      const sessionID = "http://127.0.0.1:9999/session";
      let firstTurnId: string | undefined;
      runtimeMock.state.subscribedEvents = [
        firstStarted.promise,
        firstSucceeded.promise,
        secondStarted.promise,
        replayedFirstStep.promise,
        secondStep.promise,
        secondSucceeded.promise,
      ];
      const completed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.tap((event) =>
          event.turnId === firstTurnId
            ? Effect.sync(() => firstCompletionSignal.resolve(undefined))
            : Effect.void,
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
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      firstTurnId = firstTurn.turnId;
      firstStarted.resolve({
        id: "first-started",
        created: 1,
        type: "session.step.started",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "first-message",
          agent: "build",
          model: { providerID: "openai", id: "gpt-5" },
          started: 1,
        },
      } satisfies OpenCodeEvent);
      firstSucceeded.resolve({
        id: "first-succeeded",
        created: 3,
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionID, seq: 3, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);
      yield* Effect.promise(() => firstCompletionSignal.promise);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      secondStarted.resolve({
        id: "second-started",
        created: 4,
        type: "session.step.started",
        durable: { aggregateID: sessionID, seq: 4, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "second-message",
          agent: "build",
          model: { providerID: "openai", id: "gpt-5" },
          started: 4,
        },
      } satisfies OpenCodeEvent);
      replayedFirstStep.resolve({
        id: "replayed-first-step",
        created: 5,
        type: "session.step.ended",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "first-message",
          finish: "stop",
          cost: 0,
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 9, write: 8 } },
        },
      } satisfies OpenCodeEvent);
      secondStep.resolve({
        id: "second-step",
        created: 6,
        type: "session.step.ended",
        durable: { aggregateID: sessionID, seq: 5, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "second-message",
          finish: "stop",
          cost: 0,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      } satisfies OpenCodeEvent);
      secondSucceeded.resolve({
        id: "second-succeeded",
        created: 7,
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionID, seq: 6, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);

      const turns = Array.from(yield* Fiber.join(completed));
      const firstCompleted = turns.find((event) => event.turnId === firstTurn.turnId);
      const secondCompleted = turns.find((event) => event.turnId === secondTurn.turnId);
      NodeAssert.equal(firstCompleted?.type, "turn.completed");
      if (firstCompleted?.type === "turn.completed") {
        NodeAssert.equal(firstCompleted.payload.tokenUsage?.usageStatus, "partial");
      }
      NodeAssert.equal(secondCompleted?.type, "turn.completed");
      if (secondCompleted?.type === "turn.completed") {
        NodeAssert.deepEqual(secondCompleted.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 14,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          outputTokens: 7,
          reasoningTokens: 2,
          hasSubagents: false,
        });
      }
    }),
  );

  it.effect("uses real native renamed titles and ignores placeholders", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-title");
      const renamed = promiseWithResolvers<unknown>();
      const placeholder = promiseWithResolvers<unknown>();
      const sessionID = "http://127.0.0.1:9999/session";
      runtimeMock.state.subscribedEvents = [renamed.promise, placeholder.promise];
      const titleFiber = yield* adapter.streamEvents.pipe(
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
      renamed.resolve({
        id: "rename",
        created: 1,
        type: "session.renamed",
        durable: { aggregateID: "http://127.0.0.1:9999/session", seq: 1, version: 1 },
        data: { sessionID, title: "Investigate timeout" },
      } satisfies OpenCodeEvent);
      placeholder.resolve({
        id: "placeholder",
        created: 2,
        type: "session.renamed",
        durable: { aggregateID: "http://127.0.0.1:9999/session", seq: 2, version: 1 },
        data: { sessionID, title: "New session - 2026-09-22T01:02:03.004Z" },
      } satisfies OpenCodeEvent);
      const event = Option.getOrThrow(yield* Fiber.join(titleFiber));
      NodeAssert.equal(event.type, "thread.metadata.updated");
      if (event.type === "thread.metadata.updated")
        NodeAssert.equal(event.payload.name, "Investigate timeout");
    }),
  );

  it.effect("logs native events against their T3 thread", () => {
    const records: Array<{ event: unknown; threadId: ThreadId | null }> = [];
    const written = promiseWithResolvers<void>();
    const layer = makeLoggedOpenCodeAdapterLayer({
      filePath: "memory://native-events",
      write: (event, threadId) =>
        Effect.sync(() => {
          records.push({ event, threadId });
          written.resolve(undefined);
        }),
      close: () => Effect.void,
    });
    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-log");
      const started = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [started.promise];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      started.resolve({
        id: "started",
        created: 1,
        type: "session.execution.started",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: { sessionID: "http://127.0.0.1:9999/session" },
      } satisfies OpenCodeEvent);
      yield* Effect.promise(() => written.promise);
      NodeAssert.equal(
        records.find(
          (record) =>
            (record.event as { event?: { type?: string } }).event?.type ===
            "session.execution.started",
        )?.threadId,
        threadId,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("continues native content streaming when event logging fails", () => {
    const attempted = promiseWithResolvers<void>();
    let writeCount = 0;
    const layer = makeLoggedOpenCodeAdapterLayer({
      filePath: "memory://native-events",
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Effect.void
          : Effect.sync(() => attempted.resolve(undefined)).pipe(
              Effect.andThen(Effect.die("log sink unavailable")),
            );
      },
      close: () => Effect.void,
    });
    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-log-failure");
      const started = promiseWithResolvers<unknown>();
      const text = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [started.promise, text.promise];
      const deltaFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "content.delta"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const sessionID = "http://127.0.0.1:9999/session";
      yield* adapter.sendTurn({
        threadId,
        input: "Keep streaming",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      started.resolve({
        id: "started",
        created: 1,
        type: "session.execution.started",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);
      yield* Effect.yieldNow;
      text.resolve({
        id: "text",
        created: 2,
        type: "session.text.delta",
        data: { sessionID, assistantMessageID: "message", ordinal: 0, delta: "still here" },
      } satisfies OpenCodeEvent);
      yield* Effect.promise(() => attempted.promise);
      yield* Effect.yieldNow;
      const delta = Option.getOrThrow(yield* Fiber.join(deltaFiber));
      NodeAssert.equal(delta.type, "content.delta");
      if (delta.type === "content.delta") NodeAssert.equal(delta.payload.delta, "still here");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps native shell tool starts to command execution items", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-shell-tool");
      const toolEvent = promiseWithResolvers<unknown>();
      const calledEvent = promiseWithResolvers<unknown>();
      const completedEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        toolEvent.promise,
        calledEvent.promise,
        completedEvent.promise,
      ];
      const started = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Run pwd",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      toolEvent.resolve({
        id: "tool-shell",
        created: 0,
        type: "session.tool.input.started",
        durable: { aggregateID: "http://127.0.0.1:9999/session", seq: 1, version: 1 },
        data: {
          sessionID: "http://127.0.0.1:9999/session",
          assistantMessageID: "msg",
          id: "call",
          name: "shell",
        },
      } satisfies OpenCodeEvent);
      calledEvent.resolve({
        id: "tool-called",
        created: 1,
        type: "session.tool.called",
        durable: { aggregateID: "http://127.0.0.1:9999/session", seq: 2, version: 1 },
        data: {
          sessionID: "http://127.0.0.1:9999/session",
          assistantMessageID: "msg",
          id: "call",
          input: { command: "pwd" },
          executed: true,
        },
      } satisfies OpenCodeEvent);
      completedEvent.resolve({
        id: "tool-success",
        created: 2,
        type: "session.tool.success",
        durable: { aggregateID: "http://127.0.0.1:9999/session", seq: 3, version: 2 },
        data: {
          sessionID: "http://127.0.0.1:9999/session",
          assistantMessageID: "msg",
          id: "call",
          executed: true,
          content: [{ type: "text", text: "ok" }],
        },
      } satisfies OpenCodeEvent);
      const events = yield* Fiber.join(started);
      const [startedItem, calledItem, completedItem] = events;
      NodeAssert.ok(startedItem?.type === "item.started");
      NodeAssert.ok(calledItem?.type === "item.updated");
      NodeAssert.ok(completedItem?.type === "item.completed");
      NodeAssert.equal(startedItem.payload.itemType, "command_execution");
      NodeAssert.deepEqual(calledItem.payload.data, { tool: "shell", command: "pwd" });
      NodeAssert.deepEqual(completedItem.payload.data, {
        tool: "shell",
        command: "pwd",
        result: "ok",
      });
    }),
  );
  it.effect("totals only parent native step usage when a child session runs", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-native-child-usage");
      const parentStarted = promiseWithResolvers<unknown>();
      const childCreated = promiseWithResolvers<unknown>();
      const childStep = promiseWithResolvers<unknown>();
      const childSucceeded = promiseWithResolvers<unknown>();
      const parentStepStarted = promiseWithResolvers<unknown>();
      const parentStep = promiseWithResolvers<unknown>();
      const parentSucceeded = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        parentStarted.promise,
        childCreated.promise,
        childStep.promise,
        childSucceeded.promise,
        parentStepStarted.promise,
        parentStep.promise,
        parentSucceeded.promise,
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
      yield* adapter.sendTurn({
        threadId,
        input: "Use only parent tokens",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
      });
      const sessionID = "http://127.0.0.1:9999/session";
      const childSessionID = "ses_child";
      parentStarted.resolve({
        id: "parent-started",
        created: 1,
        type: "session.execution.started",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);
      childCreated.resolve({
        id: "child-created",
        created: 2,
        type: "session.created",
        durable: { aggregateID: childSessionID, seq: 1, version: 1 },
        data: {
          sessionID: childSessionID,
          projectID: "project",
          location: { directory: process.cwd() },
          parentID: sessionID,
          slug: "child",
          version: "2",
        },
      } satisfies OpenCodeEvent);
      childStep.resolve({
        id: "child-step",
        created: 3,
        type: "session.step.ended",
        durable: { aggregateID: childSessionID, seq: 2, version: 1 },
        data: {
          sessionID: childSessionID,
          assistantMessageID: "child-message",
          finish: "stop",
          cost: 0,
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 9, write: 8 } },
        },
      } satisfies OpenCodeEvent);
      childSucceeded.resolve({
        id: "child-succeeded",
        created: 4,
        type: "session.execution.succeeded",
        durable: { aggregateID: childSessionID, seq: 3, version: 1 },
        data: { sessionID: childSessionID },
      } satisfies OpenCodeEvent);
      parentStepStarted.resolve({
        id: "parent-step-started",
        created: 5,
        type: "session.step.started",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "parent-message",
          agent: "build",
          model: { providerID: "openai", id: "gpt-5" },
          started: 5,
        },
      } satisfies OpenCodeEvent);
      parentStep.resolve({
        id: "parent-step",
        created: 6,
        type: "session.step.ended",
        durable: { aggregateID: sessionID, seq: 3, version: 1 },
        data: {
          sessionID,
          assistantMessageID: "parent-message",
          finish: "stop",
          cost: 0,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
        },
      } satisfies OpenCodeEvent);
      parentSucceeded.resolve({
        id: "parent-succeeded",
        created: 7,
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionID, seq: 4, version: 1 },
        data: { sessionID },
      } satisfies OpenCodeEvent);
      const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));
      NodeAssert.equal(completed.type, "turn.completed");
      if (completed.type === "turn.completed") {
        NodeAssert.deepEqual(completed.payload.tokenUsage, {
          usageStatus: "complete",
          usageScope: "main_agent",
          inputTokens: 14,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          outputTokens: 7,
          reasoningTokens: 2,
          hasSubagents: true,
        });
      }
    }),
  );
});
