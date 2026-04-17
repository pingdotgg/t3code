import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { beforeEach, vi } from "vitest";

import { ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  appendOpenCodeAssistantTextDelta,
  makeOpenCodeAdapterLive,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const runtimeMock = vi.hoisted(() => {
  type MessageEntry = {
    info: {
      id: string;
      role: "user" | "assistant";
    };
    parts: Array<unknown>;
  };

  const state = {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptAsyncError: null as Error | null,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
  };

  return {
    state,
    reset() {
      state.startCalls.length = 0;
      state.sessionCreateUrls.length = 0;
      state.authHeaders.length = 0;
      state.abortCalls.length = 0;
      state.closeCalls.length = 0;
      state.revertCalls.length = 0;
      state.promptAsyncError = null;
      state.closeError = null;
      state.messages = [];
      state.subscribedEvents = [];
    },
  };
});

vi.mock("../opencodeRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../opencodeRuntime.ts")>("../opencodeRuntime.ts");

  return {
    ...actual,
    startOpenCodeServerProcess: vi.fn(async ({ binaryPath }: { binaryPath: string }) => {
      runtimeMock.state.startCalls.push(binaryPath);
      return {
        url: "http://127.0.0.1:4301",
        process: {
          once() {},
        },
        close() {},
      };
    }),
    connectToOpenCodeServer: vi.fn(async ({ serverUrl }: { serverUrl?: string }) => ({
      url: serverUrl ?? "http://127.0.0.1:4301",
      process: null,
      external: Boolean(serverUrl),
      close() {
        runtimeMock.state.closeCalls.push(serverUrl ?? "http://127.0.0.1:4301");
        if (runtimeMock.state.closeError) {
          throw runtimeMock.state.closeError;
        }
      },
    })),
    createOpenCodeSdkClient: vi.fn(
      ({ baseUrl, serverPassword }: { baseUrl: string; serverPassword?: string }) => ({
        session: {
          create: vi.fn(async () => {
            runtimeMock.state.sessionCreateUrls.push(baseUrl);
            runtimeMock.state.authHeaders.push(
              serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
            );
            return { data: { id: `${baseUrl}/session` } };
          }),
          abort: vi.fn(async ({ sessionID }: { sessionID: string }) => {
            runtimeMock.state.abortCalls.push(sessionID);
          }),
          promptAsync: vi.fn(async () => {
            if (runtimeMock.state.promptAsyncError) {
              throw runtimeMock.state.promptAsyncError;
            }
          }),
          messages: vi.fn(async () => ({ data: runtimeMock.state.messages })),
          revert: vi.fn(
            async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
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
          ),
        },
        event: {
          subscribe: vi.fn(async () => ({
            stream: (async function* () {
              for (const event of runtimeMock.state.subscribedEvents) {
                yield event;
              }
            })(),
          })),
        },
      }),
    ),
  };
});

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const OpenCodeAdapterTestLayer = makeOpenCodeAdapterLive().pipe(
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

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: "opencode",
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

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
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

  it.effect("clears session state when stopAll cleanup fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      const error = yield* adapter.stopAll().pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterProcessError");
      assert.equal(error.detail, "Failed to stop 2 OpenCode sessions.");
      assert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      assert.deepEqual(sessions, []);
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            provider: "opencode",
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

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: "opencode",
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

      assert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      assert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("deduplicates overlapping assistant text deltas after part updates", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hello world!");

      assert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", " world", "!"],
      );
      assert.equal(secondUpdate.latestText, "Hello world!");
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

      const adapterLayer = makeOpenCodeAdapterLive({ nativeEventLogger }).pipe(
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
          provider: "opencode",
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

      const adapterLayer = makeOpenCodeAdapterLive({ nativeEventLogger }).pipe(
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

      const sessions = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* sleep(10);
        return yield* adapter.listSessions();
      }).pipe(Effect.provide(adapterLayer));

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      assert.deepEqual(runtimeMock.state.closeCalls, []);
    }),
  );
});
