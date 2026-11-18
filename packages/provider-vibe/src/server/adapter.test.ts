import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CheckpointId,
  ContextHandoffId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  RunAttemptId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { VibeSettings } from "../settings.ts";
import { makeVibeAdapterV2 } from "./adapter.ts";
import { withVibeAppServerClient } from "./appServerSupport.ts";
import { makeVibeTextGeneration } from "./textGeneration.ts";
import { checkVibeProviderStatus } from "./status.ts";

const decodeSettings = Schema.decodeSync(VibeSettings);

const layerTest = Layer.mergeAll(
  SecureRandom.layerWebCrypto,
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

type FakeReply = (
  | { readonly result: unknown }
  | { readonly error: { readonly code: string; readonly message: string } }
) & { readonly notifications?: ReadonlyArray<{ id?: number; method: string; params: unknown }> };

const fakeVibeProcess = Effect.fn("fakeVibeProcess")(function* (
  reply: (method: string, params: Record<string, unknown>) => FakeReply | undefined = () =>
    undefined,
) {
  const responses = yield* Queue.unbounded<Record<string, unknown>>();
  const requests = yield* Queue.unbounded<{ readonly method: string; readonly params: unknown }>();
  const encoder = new TextEncoder();
  let activeStdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const send = (value: unknown) =>
    Queue.offer(activeStdout, encoder.encode(`${JSON.stringify(value)}\n`));
  let processCount = 0;
  let turnCount = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      processCount++;
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      activeStdout = stdout;
      yield* Effect.addFinalizer(() => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)));
      const sendToProcess = (value: unknown) =>
        Queue.offer(stdout, encoder.encode(`${JSON.stringify(value)}\n`));
      const decoder = new TextDecoder();
      let buffer = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_000 + processCount),
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += decoder.decode(chunk, { stream: true });
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n");
              const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
              buffer = buffer.slice(end + 1);
              if (!("id" in message)) continue;
              if (!("method" in message)) {
                yield* Queue.offer(responses, message);
                continue;
              }
              const method = String(message["method"]);
              const params = (message["params"] ?? {}) as Record<string, unknown>;
              yield* Queue.offer(requests, { method, params });
              const custom = reply(method, params);
              if (custom !== undefined) {
                const { notifications, ...response } = custom;
                for (const notification of notifications ?? []) {
                  yield* sendToProcess({ jsonrpc: "2.0", ...notification });
                }
                yield* sendToProcess({ jsonrpc: "2.0", id: message["id"], ...response });
                continue;
              }
              let result: unknown = {};
              if (method === "initialize")
                result = { serverInfo: { name: "vibe-app-server", version: "3.1.0" } };
              if (method === "session/start" || method === "session/resume")
                result = { state: { session: { id: "native-session", cwd: process.cwd() } } };
              if (method === "turn/start") {
                turnCount++;
                result = {
                  turn: {
                    id: `turn-${turnCount}`,
                    sessionId: "native-session",
                    status: "in_progress",
                  },
                };
              }
              yield* sendToProcess({ jsonrpc: "2.0", id: message["id"], result });
              if (method === "session/stop") {
                yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
                yield* Queue.end(stdout);
              }
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const takeRequest = (method: string) =>
    Effect.gen(function* () {
      while (true) {
        const request = yield* Queue.take(requests);
        if (request.method === method) return request.params;
      }
    });
  return { spawner, send, responses, takeRequest };
});

/** Opens an adapter session against an in-memory vibe-app-server speaking line-delimited JSON-RPC. */
const openFakeVibe = Effect.fn("openFakeVibe")(function* (
  reply?: (method: string, params: Record<string, unknown>) => FakeReply | undefined,
  existingProviderThread?: OrchestrationV2ProviderThread,
) {
  const { spawner, send, responses, takeRequest } = yield* fakeVibeProcess(reply);
  const instanceId = ProviderInstanceId.make("vibe");
  const threadId = ThreadId.make("vibe-thread");
  const modelSelection = { instanceId, model: "mistral-large" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
  });

  const adapter = yield* makeVibeAdapterV2({
    instanceId,
    settings: decodeSettings({}),
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped({ startImmediately: true }),
  );

  const providerThread =
    existingProviderThread ??
    (yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy }));
  const takeEvent = <T extends ProviderAdapter.ProviderAdapterV2Event["type"]>(type: T) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === type)
          return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    });
  const notify = (method: string, params: Record<string, unknown>) =>
    send({ jsonrpc: "2.0", method, params: { sessionId: "native-session", ...params } });
  return {
    runtime,
    providerThread,
    threadId,
    modelSelection,
    runtimePolicy,
    send,
    notify,
    responses,
    takeEvent,
    takeRequest,
  };
});

const millis = (value: DateTime.Utc | null) =>
  value === null ? null : DateTime.toEpochMillis(value);

describe("Vibe adapter against an in-memory app-server", () => {
  it.effect(
    "keeps unavailable account data unknown and reports missing credentials for installed providers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const unauthorized of [false, true]) {
            const { spawner } = yield* fakeVibeProcess((method) => {
              if (unauthorized && method === "session/start")
                return { error: { code: "unauthorized", message: "Missing MISTRAL_API_KEY" } };
              if (method === "account/read")
                return { result: { account: { status: "unavailable" } } };
              return undefined;
            });
            const status = yield* checkVibeProviderStatus(
              decodeSettings({ enabled: true }),
              {},
              process.cwd(),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            expect(status.installed).toBe(true);
            expect(status.auth.status).toBe(unauthorized ? "unauthenticated" : "unknown");
            expect(status.status).toBe("warning");
          }
        }),
      ),
  );

  it.effect("preserves the orchestrator's provider thread id on resume and streamed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {
          runtime,
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
          notify,
          takeEvent,
        } = yield* openFakeVibe((method) =>
          method === "session/history/list" ? { result: { items: [] } } : undefined,
        );
        const id = ProviderThreadId.make("orchestrator-thread");
        const stored = {
          ...providerThread,
          id,
          createdAt: DateTime.makeUnsafe(1_700_000_000_000),
          handoffIds: [ContextHandoffId.make("previous-handoff")],
          forkedFrom: { providerThreadId: ProviderThreadId.make("parent-thread") },
        };
        const resumed = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: stored,
        });
        expect(resumed).toMatchObject({
          id,
          createdAt: stored.createdAt,
          handoffIds: stored.handoffIds,
          forkedFrom: stored.forkedFrom,
        });
        yield* notify("turn/started", { turn: { id: "stable-thread-turn" } });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn.providerThreadId).toBe(id);
        const nativeHistory = [
          {
            id: "u1",
            type: "message",
            role: "user",
            turnId: "t1",
            content: [{ type: "text", text: "one" }],
          },
          {
            id: "u2",
            type: "message",
            role: "user",
            turnId: "t2",
            content: [{ type: "text", text: "two" }],
          },
        ];
        const nativeMutations: string[] = [];
        const restarted = yield* openFakeVibe((method, params) => {
          if (method === "session/resume") nativeMutations.push(method);
          if (method === "session/read")
            return { result: { state: { session: { id: "native-session" } } } };
          if (method === "session/history/list") return { result: { items: nativeHistory } };
          if (method === "session/rewind") {
            if (nativeMutations.at(-1) !== "session/resume")
              return { error: { code: "conflict", message: "Session is not attached" } };
            expect(params).toEqual({ sessionId: "native-session", entryId: "u2", inplace: true });
            nativeMutations.push(method);
            nativeHistory.splice(1);
            return { result: {} };
          }
          return undefined;
        }, resumed);
        const snapshot = yield* restarted.runtime.readThreadSnapshot({ providerThread: resumed });
        const restored = yield* restarted.runtime.rollbackThread({
          providerThread: resumed,
          providerThreadTurns: snapshot.providerTurns,
          target: {
            type: "provider_turn",
            providerTurn: snapshot.providerTurns[0]!,
            appRunOrdinal: 1,
            checkpointId: CheckpointId.make("restart-restore"),
          },
        });
        expect(restored.providerTurns.map((turn) => turn.nativeTurnRef?.nativeId)).toEqual(["t1"]);
        expect(nativeMutations).toEqual(["session/resume", "session/rewind"]);
        const restoredNative = yield* restarted.runtime.readThreadSnapshot({
          providerThread: resumed,
        });
        expect(restoredNative.messages.map((message) => message.text)).toEqual(["one"]);
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("declines a non-interactive callback while keeping the protocol reader open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spawner, send, responses, takeRequest } = yield* fakeVibeProcess();
        yield* withVibeAppServerClient({ cwd: process.cwd() }, (client) =>
          Effect.gen(function* () {
            yield* send({
              jsonrpc: "2.0",
              id: 100,
              method: "callback/call",
              params: {
                sessionId: "native-session",
                callback: { callbackId: "approval", detail: { kind: "approval" } },
              },
            });
            expect(yield* Queue.take(responses)).toEqual({
              jsonrpc: "2.0",
              id: 100,
              result: { callbackId: "approval", accepted: true },
            });
            expect(yield* takeRequest("callback/result")).toEqual({
              sessionId: "native-session",
              result: {
                callbackId: "approval",
                output: { type: "approval", decision: { type: "deny" } },
              },
            });
            expect(yield* client.setupStatus()).toEqual({});
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      }),
    ),
  );

  it.effect(
    "generates a branch name with tools disabled and deletes the session on success or failure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const failHistory of [false, true]) {
            const { spawner, takeRequest } = yield* fakeVibeProcess((method) => {
              if (method === "session/read") {
                const session = { id: "native-session" };
                return {
                  result: {
                    state: {
                      session,
                      turns: [{ id: "turn-1", sessionId: session.id, status: "completed" }],
                    },
                  },
                };
              }
              if (method === "session/history/list") {
                return failHistory
                  ? { error: { code: "internal_error", message: "raw diagnostic" } }
                  : {
                      result: {
                        items: [
                          {
                            type: "message",
                            role: "assistant",
                            turnId: "turn-1",
                            content: [
                              { type: "text", text: JSON.stringify({ branch: "fix-layout" }) },
                            ],
                          },
                          {
                            type: "message",
                            role: "assistant",
                            turnId: "other",
                            content: [
                              { type: "text", text: JSON.stringify({ branch: "wrong-turn" }) },
                            ],
                          },
                        ],
                      },
                    };
              }
              return undefined;
            });
            const generation = yield* makeVibeTextGeneration(decodeSettings({}), {}).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            );
            const request = {
              cwd: process.cwd(),
              message: "Fix the layout",
              modelSelection: {
                instanceId: ProviderInstanceId.make("vibe"),
                model: "mistral-large",
                options: [{ id: "thinking", value: "high" }],
              },
            };
            if (failHistory) {
              const failure = yield* Effect.flip(generation.generateBranchName(request));
              expect(failure.detail).toBe("Vibe app server request failed.");
            } else {
              expect((yield* generation.generateBranchName(request)).branch).toContain(
                "fix-layout",
              );
            }
            expect(yield* takeRequest("session/start")).toMatchObject({
              agentConfig: { agent: "ask", autoApprove: false, disabledTools: ["*"] },
              reasoningEffort: "high",
            });
            expect(yield* takeRequest("session/delete")).toEqual({ sessionId: "native-session" });
          }
        }),
      ),
  );

  it.effect("publishes callbacks received while settling a resumed turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = { id: "native-session" };
        const { runtime, providerThread, runtimePolicy, notify, send, responses, takeEvent } =
          yield* openFakeVibe((method) => {
            if (method === "session/resume") {
              return {
                result: {
                  state: {
                    session,
                    turns: [{ id: "previous-turn", sessionId: session.id, status: "completed" }],
                  },
                },
              };
            }
            if (method === "session/history/list") return { result: { items: [] } };
            return undefined;
          });
        yield* notify("turn/started", { turn: { id: "previous-turn" } });
        yield* takeEvent("provider_turn.updated");

        const settling = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const clock = yield* Clock.Clock;
        let reads = 0;
        const resume = yield* runtime.resumeThread({ providerThread, runtimePolicy }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            // The first timestamp is for the resumed thread, the second for its terminal turn.
            currentTimeMillis: Effect.gen(function* () {
              if (++reads === 2) {
                yield* Deferred.succeed(settling, undefined);
                yield* Deferred.await(finish);
              }
              return yield* clock.currentTimeMillis;
            }),
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(settling);
        yield* notify("turn/started", { turn: { id: "next-turn" } });
        const sendApproval = (id: number, callbackId: string) =>
          send({
            jsonrpc: "2.0",
            id,
            method: "callback/call",
            params: {
              sessionId: session.id,
              callback: { callbackId, turnId: "next-turn", detail: { kind: "approval" } },
            },
          });
        yield* sendApproval(100, "during-resume");
        expect((yield* Queue.take(responses))["result"]).toEqual({
          callbackId: "during-resume",
          accepted: true,
        });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(resume);

        yield* notify("turn/started", { turn: { id: "next-turn" } });
        yield* sendApproval(101, "after-resume");
        yield* Queue.take(responses);
        expect(
          (yield* takeEvent("runtime_request.updated")).runtimeRequest.nativeRequestRef,
        ).toMatchObject({ nativeId: "during-resume" });
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("publishes completed snapshot output before newer patches and the terminal event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = { id: "native-session" };
        const turnId = "tracked-turn";
        const entry = (id: string, turn: string, text: string, generationStatus: string) => ({
          id,
          turnId: turn,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
          generationStatus,
        });
        const patch = (eventId: number, value: string) => ({
          method: "history/entryUpdated",
          params: {
            sessionId: session.id,
            eventId,
            entryId: "answer",
            patch: [{ op: "append", path: "/content/0/text", value }],
          },
        });
        const reasoning = {
          id: "reasoning",
          turnId,
          type: "reasoning",
          text: "Check the layout",
          generationStatus: "completed",
          updatedAt: 1_700_000_000_000,
        };
        const { runtime, providerThread, notify, takeEvent } = yield* openFakeVibe((method) => {
          if (method === "session/resume") {
            return {
              result: {
                state: {
                  session,
                  eventId: 10,
                  turns: [{ id: turnId, sessionId: session.id, status: "completed" }],
                  history: [
                    entry("old-answer", "earlier-turn", "Earlier", "completed"),
                    reasoning,
                    entry("answer", turnId, "Hello", "completed"),
                  ],
                },
              },
            };
          }
          if (method === "session/history/list") {
            return { result: { items: [] }, notifications: [patch(9, "lo"), patch(11, "!")] };
          }
          return undefined;
        });
        yield* notify("turn/started", { turn: { id: turnId } });
        yield* takeEvent("provider_turn.updated");
        yield* notify("history/entryAdded", { entry: reasoning });
        const live = (yield* takeEvent("turn_item.updated")).turnItem;
        yield* notify("history/entryAdded", {
          entry: entry("answer", turnId, "Hel", "in_progress"),
        });
        expect((yield* takeEvent("message.updated")).message.text).toBe("Hel");
        yield* takeEvent("turn_item.updated");

        yield* runtime.resumeThread({ providerThread });
        const replayed = (yield* takeEvent("turn_item.updated")).turnItem;
        expect(replayed.type).toBe("reasoning");
        expect(replayed.completedAt).toEqual(live.completedAt);
        expect(millis(replayed.completedAt)).toBe(reasoning.updatedAt);
        expect((yield* takeEvent("message.updated")).message).toMatchObject({
          text: "Hello",
          streaming: false,
        });
        expect((yield* takeEvent("message.updated")).message.text).toBe("Hello!");
        expect((yield* takeEvent("turn.terminal")).status).toBe("completed");
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("publishes a question card, returns the answer, and resolves the card", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let interruptCalls = 0;
        const vibe = yield* openFakeVibe((method) =>
          method === "turn/interrupt" && interruptCalls++ === 0
            ? { error: { code: "conflict", message: "Cannot interrupt this turn" } }
            : undefined,
        );
        const { runtime, takeEvent, takeRequest } = vibe;

        yield* vibe.send({
          jsonrpc: "2.0",
          id: 100,
          method: "callback/call",
          params: {
            callback: {
              callbackId: "native-question",
              detail: {
                kind: "user_input",
                request: {
                  questions: [
                    {
                      question: "Ready?",
                      options: [{ label: "Yes" }, { label: "Later" }],
                    },
                  ],
                },
              },
            },
          },
        });
        expect((yield* Queue.take(vibe.responses))["result"]).toEqual({
          callbackId: "native-question",
          accepted: true,
        });

        const card = yield* takeEvent("turn_item.updated");
        const pending = yield* takeEvent("runtime_request.updated");
        if (card.turnItem.type !== "user_input_request") throw new Error("Missing question card");
        expect(pending.runtimeRequest.kind).toBe("user_input");
        expect(card.turnItem.status).toBe("waiting");
        expect(card.turnItem.requestId).toBe(pending.runtimeRequest.id);

        yield* TestClock.adjust("1 second");
        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { "question-0": "Yes" },
        });
        expect(yield* takeRequest("callback/result")).toEqual({
          sessionId: "native-session",
          result: {
            callbackId: "native-question",
            output: {
              type: "user_input",
              result: {
                answers: [{ question: "Ready?", answer: "Yes", isOther: false }],
                cancelled: false,
              },
            },
          },
        });
        expect(yield* takeEvent("turn_item.updated")).toMatchObject({
          turnItem: { id: card.turnItem.id, status: "completed" },
        });
        expect(yield* takeEvent("runtime_request.updated")).toMatchObject({
          runtimeRequest: {
            id: pending.runtimeRequest.id,
            kind: "user_input",
            status: "resolved",
            createdAt: pending.runtimeRequest.createdAt,
          },
        });
        yield* vibe.notify("turn/started", { turn: { id: "native-turn" } });
        const started = yield* takeEvent("provider_turn.updated");
        const interruptInput = {
          providerThread: vibe.providerThread,
          providerTurnId: started.providerTurn.id,
        };
        const rejected = yield* Effect.result(runtime.interruptTurn(interruptInput));
        expect(Result.isFailure(rejected)).toBe(true);
        if (Result.isFailure(rejected))
          expect(rejected.failure._tag).toBe("ProviderAdapterProtocolError");
        expect(yield* takeRequest("turn/interrupt")).toEqual({
          sessionId: "native-session",
          expectedTurnId: "native-turn",
        });
        yield* runtime.interruptTurn(interruptInput);
        expect(yield* takeRequest("turn/interrupt")).toEqual({
          sessionId: "native-session",
          expectedTurnId: "native-turn",
        });
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("streams entries until Vibe completes them and keeps the turn start time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { notify, takeEvent } = yield* openFakeVibe();
        yield* notify("turn/started", { turn: { id: "native-turn" } });
        const started = yield* takeEvent("provider_turn.updated");

        yield* notify("history/entryAdded", {
          entry: {
            id: "answer",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Hel" }],
            generationStatus: "in_progress",
            createdAt: 1_700_000_000_000,
          },
        });
        expect((yield* takeEvent("message.updated")).message).toMatchObject({
          text: "Hel",
          streaming: true,
        });
        expect((yield* takeEvent("turn_item.updated")).turnItem).toMatchObject({
          status: "running",
          streaming: true,
          completedAt: null,
        });
        yield* notify("history/entryUpdated", {
          entryId: "answer",
          patch: [{ op: "append", path: "/content/0/text", value: "lo" }],
        });
        const streamed = (yield* takeEvent("message.updated")).message;
        expect(streamed).toMatchObject({ text: "Hello", streaming: true });
        expect(millis(streamed.createdAt)).toBe(1_700_000_000_000);
        yield* notify("history/entryUpdated", {
          entryId: "answer",
          patch: [{ op: "replace", path: "/generationStatus", value: "completed" }],
        });
        expect((yield* takeEvent("message.updated")).message).toMatchObject({
          text: "Hello",
          streaming: false,
        });
        expect((yield* takeEvent("turn_item.updated")).turnItem).toMatchObject({
          type: "assistant_message",
          status: "completed",
          streaming: false,
        });

        // Vibe can end a turn with an entry still in progress: it must still get a final snapshot.
        yield* notify("history/entryAdded", {
          entry: {
            id: "thought",
            type: "reasoning",
            text: "Hmm",
            generationStatus: "in_progress",
            updatedAt: 1_700_000_000_000,
          },
        });
        expect((yield* takeEvent("turn_item.updated")).turnItem).toMatchObject({
          type: "reasoning",
          streaming: true,
        });
        const completedAt = 1_700_000_000_100;
        yield* notify("turn/completed", {
          turn: { id: "native-turn", status: "completed", completedAt },
        });
        const finalReasoning = (yield* takeEvent("turn_item.updated")).turnItem;
        expect(finalReasoning).toMatchObject({
          type: "reasoning",
          status: "completed",
          streaming: false,
        });
        expect(millis(finalReasoning.completedAt)).toBe(completedAt);
        const completed = (yield* takeEvent("provider_turn.updated")).providerTurn;
        expect(completed.status).toBe("completed");
        expect(completed.startedAt).not.toBeNull();
        expect(millis(completed.startedAt)).toBe(millis(started.providerTurn.startedAt));
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("starts one turn at a time with its own selection and rejects stale controls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let modelWrites = 0;
        let starts = 0;
        let failNextResume = false;
        let historyFailure: "buffered-terminal" | "snapshot-terminal" | undefined;
        const answer = (turnId: string, text: string, generationStatus: string) => ({
          id: `answer-${turnId}`,
          turnId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text }],
          generationStatus,
        });
        const resumedAgents: unknown[] = [];
        const vibe = yield* openFakeVibe((method, params) => {
          if (method === "session/resume") {
            resumedAgents.push(params["agentConfig"]);
            if (failNextResume) {
              failNextResume = false;
              return { error: { code: "unavailable", message: "Plan resume failed" } };
            }
            if (historyFailure !== undefined) {
              const session = { id: "native-session" };
              return {
                result: {
                  state: {
                    session,
                    eventId: 11,
                    ...(historyFailure === "snapshot-terminal"
                      ? {
                          turns: [{ id: "turn-3", sessionId: session.id, status: "completed" }],
                          history: [answer("turn-3", "Final answer", "completed")],
                        }
                      : { history: [answer("turn-1", "Hello", "in_progress")] }),
                  },
                },
              };
            }
          }
          if (method === "config/model/write" && ++modelWrites === 2) {
            return { result: { failures: ["Model unavailable"] } };
          }
          if (method === "turn/start") starts += 1;
          if (method === "session/history/list") {
            if (historyFailure !== undefined) {
              const notificationMode = historyFailure;
              historyFailure = undefined;
              return {
                error: { code: "unavailable", message: "History read failed after resume" },
                ...(notificationMode === "buffered-terminal"
                  ? {
                      notifications: [
                        {
                          method: "history/entryUpdated",
                          params: {
                            eventId: 9,
                            sessionId: "native-session",
                            entryId: "older-turn-1",
                            patch: [{ op: "append", path: "/content/0/text", value: " done" }],
                          },
                        },
                        {
                          method: "history/entryUpdated",
                          params: {
                            eventId: 10,
                            sessionId: "native-session",
                            entryId: "answer-turn-1",
                            patch: [{ op: "append", path: "/content/0/text", value: "lo" }],
                          },
                        },
                        {
                          method: "history/entryUpdated",
                          params: {
                            eventId: 12,
                            sessionId: "native-session",
                            entryId: "answer-turn-1",
                            patch: [{ op: "append", path: "/content/0/text", value: " world" }],
                          },
                        },
                        {
                          method: "turn/interrupted",
                          params: { sessionId: "native-session", turn: { id: "turn-1" } },
                        },
                      ],
                    }
                  : {}),
              };
            }
            return { result: { items: [] } };
          }
          return undefined;
        });
        const {
          runtime,
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
          notify,
          takeEvent,
          takeRequest,
        } = vibe;
        const now = yield* DateTime.now;
        const host = yield* ProviderHost.ProviderHost;
        const fs = yield* FileSystem.FileSystem;
        const image = {
          type: "image" as const,
          id: ChatAttachmentId.make("screenshot"),
          name: "layout.png",
          mimeType: "image/png",
          sizeBytes: 3,
        };
        yield* fs.writeFile(host.resolveAttachmentPath(image)!, new Uint8Array([1, 2, 3]));
        const input = (ordinal: number): ProviderAdapter.ProviderAdapterV2TurnInput => ({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          runId: RunId.make(`run-${ordinal}`),
          attemptId: RunAttemptId.make(`attempt-${ordinal}`),
          rootNodeId: NodeId.make(`root-${ordinal}`),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project"),
            title: "Vibe test",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: providerThread.providerInstanceId,
            modelSelection,
            runtimeMode: runtimePolicy.runtimeMode,
            interactionMode: runtimePolicy.interactionMode,
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
            messageId: MessageId.make(`message-${ordinal}`),
            text: "Fix this layout",
            attachments: [image],
            createdBy: "user",
            creationSource: "web",
          },
        });
        yield* runtime.startTurn(input(1));
        expect(yield* takeRequest("turn/start")).toMatchObject({
          clientUserMessageId: "message-1",
          message: [
            { type: "text", text: "Fix this layout" },
            {
              type: "image",
              attachment: { source: { kind: "inline", data: "AQID" }, mimeType: "image/png" },
            },
          ],
        });
        expect((yield* takeEvent("provider_thread.updated")).providerThread.status).toBe("idle");
        expect((yield* takeEvent("provider_thread.updated")).providerThread.status).toBe("active");
        const first = (yield* takeEvent("provider_turn.updated")).providerTurn;
        expect((yield* Effect.flip(runtime.startTurn(input(2))))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        expect(modelWrites).toBe(1);
        expect(starts).toBe(1);
        failNextResume = true;
        expect(
          (yield* Effect.flip(runtime.resumeThread({ providerThread, runtimePolicy })))._tag,
        ).toBe("ProviderAdapterProtocolError");
        yield* notify("history/entryAdded", {
          entry: { ...answer("turn-1", "Older", "in_progress"), id: "older-turn-1" },
        });
        expect((yield* takeEvent("message.updated")).message.text).toBe("Older");
        yield* notify("history/entryAdded", { entry: answer("turn-1", "Hel", "in_progress") });
        expect((yield* takeEvent("message.updated")).message.text).toBe("Hel");
        historyFailure = "buffered-terminal";
        expect(
          (yield* Effect.flip(runtime.resumeThread({ providerThread, runtimePolicy })))._tag,
        ).toBe("ProviderAdapterProtocolError");
        let finalMessage = (yield* takeEvent("message.updated")).message;
        while (finalMessage.streaming) finalMessage = (yield* takeEvent("message.updated")).message;
        expect(finalMessage.text).toBe("Older done");
        expect((yield* takeEvent("message.updated")).message).toMatchObject({
          text: "Hello world",
          streaming: false,
        });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn).toMatchObject({
          id: first.id,
          nodeId: input(1).rootNodeId,
          runAttemptId: input(1).attemptId,
          status: "interrupted",
        });
        expect((yield* takeEvent("provider_thread.updated")).providerThread.status).toBe("idle");
        expect(yield* takeEvent("turn.terminal")).toMatchObject({ runOrdinal: 1 });

        const rejection = yield* Effect.flip(runtime.startTurn(input(2)));
        expect(rejection._tag).toBe("ProviderAdapterTurnStartError");
        expect(starts).toBe(1);
        const third = input(3);
        yield* runtime.startTurn({
          ...third,
          modelSelection: { ...third.modelSelection, options: [{ id: "thinking", value: "low" }] },
        });
        expect(yield* takeRequest("config/model/write")).toMatchObject({ sessionOnly: true });
        expect(yield* takeRequest("config/model/write")).toMatchObject({ reasoningEffort: "low" });
        const second = (yield* takeEvent("provider_turn.updated")).providerTurn;
        expect(second).toMatchObject({
          ordinal: 3,
          nodeId: input(3).rootNodeId,
          runAttemptId: input(3).attemptId,
        });
        const stale = { providerThread, providerTurnId: first.id };
        expect((yield* Effect.flip(runtime.interruptTurn(stale)))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        yield* runtime.interruptTurn({ ...stale, requestRuntimeRestart: true });
        const steer = {
          ...stale,
          threadId,
          runId: input(3).runId,
          message: { ...input(3).message, messageId: MessageId.make("steered-message") },
        };
        expect((yield* Effect.flip(runtime.steerTurn(steer)))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        yield* runtime.steerTurn({ ...steer, providerTurnId: second.id });
        expect(yield* takeRequest("turn/steer")).toMatchObject({
          clientUserMessageId: "steered-message",
          expectedTurnId: "turn-2",
          message: [
            { type: "text", text: "Fix this layout" },
            {
              type: "image",
              attachment: { source: { kind: "inline", data: "AQID" }, mimeType: "image/png" },
            },
          ],
        });
        yield* notify("turn/completed", { turn: { id: "turn-2" } });
        yield* takeEvent("turn.terminal");
        for (const interactionMode of ["plan", "default"] as const) {
          yield* runtime.resumeThread({
            providerThread,
            runtimePolicy: { ...runtimePolicy, interactionMode },
          });
          expect(yield* takeRequest("initialize")).toMatchObject({
            clientInfo: { name: "t3-code" },
          });
          expect(yield* takeRequest("session/stop")).toEqual({ sessionId: "native-session" });
          expect(yield* takeRequest("session/resume")).toMatchObject({
            sessionId: "native-session",
            agentConfig:
              interactionMode === "plan"
                ? { agent: "ask", autoApprove: false, enabledTools: ["grep", "read_file"] }
                : { agent: "accept-edits", autoApprove: true },
          });
        }
        failNextResume = true;
        expect(
          (yield* Effect.flip(
            runtime.resumeThread({
              providerThread,
              runtimePolicy: { ...runtimePolicy, interactionMode: "plan" },
            }),
          ))._tag,
        ).toBe("ProviderAdapterProtocolError");
        yield* runtime.startTurn(input(4));
        expect(resumedAgents).toHaveLength(7);
        expect(resumedAgents.at(-1)).toMatchObject({ agent: "accept-edits" });
        const last = (yield* takeEvent("provider_turn.updated")).providerTurn;
        historyFailure = "snapshot-terminal";
        expect(
          (yield* Effect.flip(runtime.resumeThread({ providerThread, runtimePolicy })))._tag,
        ).toBe("ProviderAdapterProtocolError");
        expect((yield* takeEvent("message.updated")).message).toMatchObject({
          text: "Final answer",
          streaming: false,
        });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn).toMatchObject({
          id: last.id,
          status: "completed",
        });
        expect(yield* takeEvent("turn.terminal")).toMatchObject({ runOrdinal: 4 });
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect.each(["rejected", "malformed", "malformed with late events"] as const)(
    "recovers final updates when a same-session resume retry is %s",
    (failure) =>
      Effect.scoped(
        Effect.gen(function* () {
          let resumeAttempts = 0;
          let interruptRequests = 0;
          const sessionId = "native-session";
          const turnId = "tracked-turn";
          const finalNotifications = [
            {
              method: "history/entryUpdated",
              params: {
                sessionId,
                eventId: 8,
                entryId: "tracked-answer",
                patch: [{ op: "append", path: "/content/0/text", value: " answer" }],
              },
            },
            { method: "turn/completed", params: { sessionId, turn: { id: turnId } } },
          ];
          const late = failure === "malformed with late events";
          const vibe = yield* openFakeVibe((method) => {
            if (method === "turn/interrupt") interruptRequests++;
            if (method === "session/history/list") {
              return { error: { code: "unavailable", message: "History read failed" } };
            }
            if (method !== "session/resume") return undefined;
            resumeAttempts++;
            if (resumeAttempts === 1) {
              return { result: { state: { session: { id: sessionId }, eventId: 5 } } };
            }
            return {
              ...(failure === "rejected"
                ? { error: { code: "conflict", message: "Resume rejected" } }
                : { result: { state: { session: {} } } }),
              notifications: [
                {
                  method: "history/entryAdded",
                  params: {
                    sessionId,
                    eventId: 6,
                    entry: {
                      id: "tracked-answer",
                      type: "message",
                      role: "assistant",
                      turnId,
                      generationStatus: "in_progress",
                      content: [{ type: "text", text: "Tracked" }],
                    },
                  },
                },
                {
                  method: "history/entryUpdated",
                  params: {
                    sessionId: "different-session",
                    eventId: 7,
                    entryId: "tracked-answer",
                    patch: [{ op: "append", path: "/content/0/text", value: " wrong" }],
                  },
                },
                ...(late ? [] : finalNotifications),
              ],
            };
          });
          yield* vibe.notify("turn/started", { turn: { id: turnId } });
          const { providerTurn } = yield* vibe.takeEvent("provider_turn.updated");

          const resume = vibe.runtime.resumeThread({ providerThread: vibe.providerThread });
          expect((yield* Effect.flip(resume))._tag).toBe("ProviderAdapterProtocolError");
          expect((yield* Effect.flip(resume))._tag).toBe("ProviderAdapterProtocolError");
          if (late) {
            for (const { method, params } of finalNotifications) yield* vibe.notify(method, params);
            yield* vibe.send({
              jsonrpc: "2.0",
              id: 500,
              method: "callback/call",
              params: { sessionId, callback: { callbackId: "late", detail: { kind: "approval" } } },
            });
            expect((yield* Queue.take(vibe.responses))["result"]).toEqual({
              callbackId: "late",
              accepted: false,
            });
          }
          yield* vibe.runtime.interruptTurn({
            providerThread: vibe.providerThread,
            providerTurnId: providerTurn.id,
          });
          expect(interruptRequests).toBe(0);

          expect((yield* vibe.takeEvent("message.updated")).message.text).toBe("Tracked");
          expect((yield* vibe.takeEvent("message.updated")).message.text).toBe("Tracked answer");
          expect((yield* vibe.takeEvent("message.updated")).message).toMatchObject({
            text: "Tracked answer",
            streaming: false,
          });
          expect(yield* vibe.takeEvent("turn.terminal")).toMatchObject({
            status: "completed",
            providerTurnId: providerTurn.id,
          });
        }).pipe(Effect.provide(layerTest)),
      ),
  );

  it.effect("keeps snapshot and live turns in order across resume and rewind", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const message = (id: string, role: string, turnId: string, text: string, at: number) => ({
          id,
          type: "message",
          role,
          turnId,
          content: [{ type: "text", text }],
          generationStatus: "completed",
          createdAt: at,
          updatedAt: at,
        });
        const turn = (id: string, at: number) => ({
          id,
          sessionId: "native-session",
          status: "completed",
          startedAt: at,
          completedAt: at + 50,
        });
        // Vibe pages newest-first; `nextCursor` names the older page.
        const pages: Record<string, Record<string, FakeReply>> = {
          "session/history/list": {
            "": {
              result: {
                items: [
                  message("u2", "user", "t2", "second", 2000),
                  message("a2", "assistant", "t2", "two", 2100),
                ],
                nextCursor: "u2",
              },
            },
            u2: {
              result: {
                items: [
                  message("s1", "system", "t1", "internal instructions", 900),
                  message("u1", "user", "t1", "first", 1000),
                  message("a1", "assistant", "t1", "one", 1100),
                ],
                nextCursor: null,
              },
            },
          },
        };
        const session = { id: "native-session" };
        let rewound = false;
        let resumeAttempt = 0;
        let resuming = false;
        const vibe = yield* openFakeVibe((method, params) => {
          if (method === "session/resume") {
            resumeAttempt++;
            resuming = true;
            return {
              result: {
                state: {
                  session,
                  eventId: 10,
                  history: [message("a2", "assistant", "t2", "two", 2100)],
                },
              },
            };
          }
          if (method === "session/rewind") {
            expect(params).toEqual({ sessionId: "native-session", entryId: "u2", inplace: true });
            rewound = true;
            return { result: {} };
          }
          if (rewound && (method === "session/read" || method === "session/history/list")) {
            return { error: { code: "unavailable", message: "read failed after rewind" } };
          }
          if (method === "session/read") {
            return {
              result: {
                state: { session, turns: [{ ...turn("t2", 2000), status: "interrupted" }] },
              },
            };
          }
          const cursor = (params["page"] as { cursor?: string } | undefined)?.cursor ?? "";
          const history = pages[method];
          if (!history) return undefined;
          if (rewound) return history["u2"];
          if (resuming && cursor === "") {
            resuming = false;
            const recovered = `recovered-${resumeAttempt}`;
            const callback = {
              id: 500 + resumeAttempt,
              method: "callback/call",
              params: {
                callback: {
                  callbackId: recovered,
                  sessionId: "native-session",
                  turnId: recovered,
                  detail: { kind: "approval" },
                },
              },
            };
            if (resumeAttempt === 1) {
              return {
                error: { code: "unavailable", message: "history failed after callback" },
                notifications: [callback],
              };
            }
            return {
              result: {
                items: [
                  message("u2", "user", "t2", "second", 2000),
                  message(
                    "a2",
                    "assistant",
                    "t2",
                    resumeAttempt === 2 ? "two" : "two continued",
                    2100,
                  ),
                ],
                nextCursor: "u2",
              },
              notifications: [
                {
                  method: "turn/started",
                  params: { sessionId: "native-session", turn: { id: recovered } },
                },
                callback,
                {
                  method: "history/entryUpdated",
                  params: {
                    sessionId: "native-session",
                    eventId: 9,
                    entryId: "a2",
                    patch: [{ op: "append", path: "/content/0/text", value: " already included" }],
                  },
                },
                {
                  method: "history/entryUpdated",
                  params: {
                    sessionId: "native-session",
                    eventId: 11,
                    entryId: "a2",
                    patch: [{ op: "append", path: "/content/0/text", value: " continued" }],
                  },
                },
              ],
            };
          }
          return history[cursor];
        });

        const {
          runtime,
          providerThread,
          threadId,
          modelSelection,
          runtimePolicy,
          notify,
          takeEvent,
        } = vibe;
        const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
        expect(
          snapshot.messages.map((entry) => [entry.createdBy, entry.text, millis(entry.createdAt)]),
        ).toEqual([
          ["user", "first", 1000],
          ["agent", "one", 1100],
          ["user", "second", 2000],
          ["agent", "two", 2100],
        ]);
        expect(
          snapshot.providerTurns.map((entry) => [
            entry.nativeTurnRef?.nativeId,
            entry.ordinal,
            entry.status,
          ]),
        ).toEqual([
          ["t1", 1, "completed"],
          ["t2", 2, "interrupted"],
        ]);

        const resume = {
          threadId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: providerThread,
        };
        expect((yield* Effect.flip(runtime.ensureThread(resume)))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        expect(yield* Queue.take(vibe.responses)).toMatchObject({
          id: 501,
          result: { callbackId: "recovered-1", accepted: true },
        });
        expect(yield* vibe.takeRequest("callback/result")).toEqual({
          sessionId: "native-session",
          result: {
            callbackId: "recovered-1",
            output: { type: "approval", decision: { type: "cancel_turn" } },
          },
        });

        yield* vibe.send({
          jsonrpc: "2.0",
          id: 599,
          method: "callback/call",
          params: {
            callback: {
              callbackId: "late-approval",
              sessionId: "native-session",
              detail: { kind: "approval" },
            },
          },
        });
        expect(yield* Queue.take(vibe.responses)).toMatchObject({
          id: 599,
          result: { callbackId: "late-approval", accepted: false },
        });

        for (const attempt of [2, 3]) {
          const nativeTurnId = `recovered-${attempt}`;
          yield* runtime.ensureThread(resume);
          const recovered = yield* takeEvent("provider_turn.updated");
          expect(recovered.providerTurn).toMatchObject({
            nativeTurnRef: { nativeId: nativeTurnId },
            ordinal: 3,
            status: "running",
          });
          expect(yield* Queue.take(vibe.responses)).toMatchObject({
            id: 500 + attempt,
            result: { callbackId: nativeTurnId, accepted: true },
          });
          expect(yield* takeEvent("runtime_request.updated")).toMatchObject({
            runtimeRequest: {
              providerTurnId: recovered.providerTurn.id,
              nodeId: recovered.providerTurn.nodeId,
            },
          });
          expect(yield* takeEvent("message.updated")).toMatchObject({
            message: { text: "two continued" },
          });
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: recovered.providerTurn.id,
          });
          expect(yield* vibe.takeRequest("turn/interrupt")).toMatchObject({
            expectedTurnId: nativeTurnId,
          });
          yield* notify("turn/started", { turn: { id: nativeTurnId } });
          yield* notify("turn/interrupted", { turn: { id: nativeTurnId } });
          expect((yield* takeEvent("provider_turn.updated")).providerTurn).toMatchObject({
            ordinal: 3,
            status: "interrupted",
          });
        }

        const providerTurn = snapshot.providerTurns[0]!;
        const rewoundSnapshot = yield* runtime.rollbackThread({
          providerThread,
          providerThreadTurns: snapshot.providerTurns,
          target: {
            type: "provider_turn",
            providerTurn,
            appRunOrdinal: 1,
            checkpointId: CheckpointId.make("rewind"),
          },
        });
        expect(rewoundSnapshot.providerTurns.map((entry) => entry.nativeTurnRef?.nativeId)).toEqual(
          ["t1"],
        );
        expect(rewoundSnapshot.messages.map((entry) => entry.text)).toEqual(["first", "one"]);
        yield* notify("turn/started", { turn: { id: "t4" } });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn.ordinal).toBe(2);
      }).pipe(Effect.provide(layerTest)),
    ),
  );
});
