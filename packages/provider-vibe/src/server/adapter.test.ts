import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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

const decodeSettings = Schema.decodeSync(VibeSettings);

const layerTest = Layer.mergeAll(
  SecureRandom.layerWebCrypto,
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

type FakeReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: string; readonly message: string } };

/** Opens an adapter session against an in-memory vibe-app-server speaking line-delimited JSON-RPC. */
const openFakeVibe = Effect.fn("openFakeVibe")(function* (
  reply: (method: string, params: Record<string, unknown>) => FakeReply | undefined = () =>
    undefined,
) {
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  yield* Effect.addFinalizer(() => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)));
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const responses = yield* Queue.unbounded<Record<string, unknown>>();
  const requests = yield* Queue.unbounded<{ readonly method: string; readonly params: unknown }>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (value: unknown) =>
    Queue.offer(stdout, encoder.encode(`${JSON.stringify(value)}\n`));
  let buffer = "";
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
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
                yield* send({ jsonrpc: "2.0", id: message["id"], ...custom });
                continue;
              }
              let result: unknown = {};
              if (method === "initialize")
                result = { serverInfo: { name: "vibe-app-server", version: "3.1.0" } };
              if (method === "session/start")
                result = { state: { session: { id: "native-session", cwd: process.cwd() } } };
              yield* send({ jsonrpc: "2.0", id: message["id"], result });
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
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
  // Exit the fake process before the session's own finalizers wait on it.
  yield* Effect.addFinalizer(() => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)));
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped({ startImmediately: true }),
  );

  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const takeEvent = <T extends ProviderAdapter.ProviderAdapterV2Event["type"]>(type: T) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === type)
          return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    });
  const takeRequest = (method: string) =>
    Effect.gen(function* () {
      while (true) {
        const request = yield* Queue.take(requests);
        if (request.method === method) return request.params;
      }
    });
  const notify = (method: string, params: Record<string, unknown>) =>
    send({ jsonrpc: "2.0", method, params: { sessionId: "native-session", ...params } });
  return { runtime, providerThread, send, notify, responses, takeEvent, takeRequest };
});

const millis = (value: DateTime.Utc | null) =>
  value === null ? null : DateTime.toEpochMillis(value);

describe("Vibe adapter against an in-memory app-server", () => {
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
          runtimeRequest: { id: pending.runtimeRequest.id, kind: "user_input", status: "resolved" },
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
          entry: { id: "thought", type: "reasoning", text: "Hmm", generationStatus: "in_progress" },
        });
        expect((yield* takeEvent("turn_item.updated")).turnItem).toMatchObject({
          type: "reasoning",
          streaming: true,
        });
        yield* notify("turn/completed", { turn: { id: "native-turn", status: "completed" } });
        expect((yield* takeEvent("turn_item.updated")).turnItem).toMatchObject({
          type: "reasoning",
          status: "completed",
          streaming: false,
        });
        const completed = (yield* takeEvent("provider_turn.updated")).providerTurn;
        expect(completed.status).toBe("completed");
        expect(completed.startedAt).not.toBeNull();
        expect(millis(completed.startedAt)).toBe(millis(started.providerTurn.startedAt));
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("reads every snapshot page in order with each message's author and time", () =>
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
                  message("u1", "user", "t1", "first", 1000),
                  message("a1", "assistant", "t1", "one", 1100),
                ],
                nextCursor: null,
              },
            },
          },
          "session/turns/list": {
            "": { result: { items: [turn("t2", 2000)], nextCursor: "t2" } },
            t2: { result: { items: [turn("t1", 1000)], nextCursor: null } },
          },
        };
        const { runtime, providerThread } = yield* openFakeVibe((method, params) => {
          const cursor = (params["page"] as { cursor?: string } | undefined)?.cursor ?? "";
          return pages[method]?.[cursor];
        });

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
          snapshot.providerTurns.map((entry) => [entry.nativeTurnRef?.nativeId, entry.ordinal]),
        ).toEqual([
          ["t1", 1],
          ["t2", 2],
        ]);
      }).pipe(Effect.provide(layerTest)),
    ),
  );
});
