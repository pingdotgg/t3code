import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  RunAttemptId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
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
import { withVibeAppServerClient } from "./appServerSupport.ts";
import { makeVibeTextGeneration } from "./textGeneration.ts";

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
) & { readonly notifications?: ReadonlyArray<{ method: string; params: unknown }> };

const fakeVibeProcess = Effect.fn("fakeVibeProcess")(function* (
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
                const { notifications, ...response } = custom;
                for (const notification of notifications ?? []) {
                  yield* send({ jsonrpc: "2.0", ...notification });
                }
                yield* send({ jsonrpc: "2.0", id: message["id"], ...response });
                continue;
              }
              let result: unknown = {};
              if (method === "initialize")
                result = { serverInfo: { name: "vibe-app-server", version: "3.1.0" } };
              if (method === "session/start" || method === "session/resume")
                result = { state: { session: { id: "native-session", cwd: process.cwd() } } };
              if (method === "session/turn/enqueue") result = { queueItemId: "queued" };
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
  const takeRequest = (method: string) =>
    Effect.gen(function* () {
      while (true) {
        const request = yield* Queue.take(requests);
        if (request.method === method) return request.params;
      }
    });
  return { spawner, exited, send, responses, takeRequest };
});

/** Opens an adapter session against an in-memory vibe-app-server speaking line-delimited JSON-RPC. */
const openFakeVibe = Effect.fn("openFakeVibe")(function* (
  reply?: (method: string, params: Record<string, unknown>) => FakeReply | undefined,
) {
  const { spawner, exited, send, responses, takeRequest } = yield* fakeVibeProcess(reply);
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
                      turns: [{ id: "draft", sessionId: session.id, status: "completed" }],
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
                            content: [
                              { type: "text", text: JSON.stringify({ branch: "fix-layout" }) },
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

  it.effect("binds queued run identity to the native input and rejects stale controls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let modelWrites = 0;
        let enqueues = 0;
        const vibe = yield* openFakeVibe((method) => {
          if (method === "config/model/write" && ++modelWrites === 2) {
            return { result: { failures: ["Model unavailable"] } };
          }
          if (method === "session/turn/enqueue") enqueues += 1;
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
        const entry = (request: unknown) =>
          (request as { entries: ReadonlyArray<{ entryId: string; content: unknown }> })
            .entries[0]!;

        yield* runtime.startTurn(input(1));
        const firstEntry = entry(yield* takeRequest("session/turn/enqueue"));
        expect(firstEntry.content).toEqual([
          { type: "text", text: "Fix this layout" },
          { type: "image", uri: "data:image/png;base64,AQID", mediaType: "image/png" },
        ]);
        yield* notify("turn/started", { turn: { id: "first", inputEntryId: firstEntry.entryId } });
        const first = (yield* takeEvent("provider_turn.updated")).providerTurn;
        const rejection = yield* Effect.flip(runtime.startTurn(input(2)));
        expect(rejection._tag).toBe("ProviderAdapterTurnStartError");
        expect(enqueues).toBe(1);
        yield* runtime.startTurn(input(3));
        const queued = entry(yield* takeRequest("session/turn/enqueue"));
        yield* notify("turn/completed", { turn: { id: "first" } });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn).toMatchObject({
          id: first.id,
          nodeId: input(1).rootNodeId,
          runAttemptId: input(1).attemptId,
          status: "completed",
        });
        expect(yield* takeEvent("turn.terminal")).toMatchObject({ runOrdinal: 1 });
        yield* notify("turn/started", { turn: { id: "second", inputEntryId: queued.entryId } });
        const second = (yield* takeEvent("provider_turn.updated")).providerTurn;
        expect(second).toMatchObject({
          nodeId: input(3).rootNodeId,
          runAttemptId: input(3).attemptId,
        });
        const stale = { providerThread, providerTurnId: first.id };
        expect((yield* Effect.flip(runtime.interruptTurn(stale)))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        yield* runtime.interruptTurn({ ...stale, requestRuntimeRestart: true });
        const steer = { ...stale, threadId, runId: input(3).runId, message: input(3).message };
        expect((yield* Effect.flip(runtime.steerTurn(steer)))._tag).toBe(
          "ProviderAdapterProtocolError",
        );
        yield* runtime.steerTurn({ ...steer, providerTurnId: second.id });
        expect(yield* takeRequest("turn/steer")).toMatchObject({
          expectedTurnId: "second",
          message: [
            { type: "text", text: "Fix this layout" },
            {
              type: "image",
              attachment: { source: { kind: "inline", data: "AQID" }, mimeType: "image/png" },
            },
          ],
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
        let resuming = false;
        const vibe = yield* openFakeVibe((method, params) => {
          if (method === "session/resume") {
            resuming = true;
            return { result: { state: { session } } };
          }
          if (method === "session/rewind") {
            expect(params).toEqual({ sessionId: "native-session", entryId: "u2", inplace: true });
            rewound = true;
            return { result: {} };
          }
          if (method === "session/read") {
            return {
              result: {
                state: {
                  session,
                  turns: rewound
                    ? [turn("t1", 1000)]
                    : [{ ...turn("t2", 2000), status: "interrupted" }],
                },
              },
            };
          }
          const cursor = (params["page"] as { cursor?: string } | undefined)?.cursor ?? "";
          const history = pages[method];
          if (!history) return undefined;
          if (rewound) return history["u2"];
          if (resuming && cursor === "") {
            resuming = false;
            return {
              ...history[""]!,
              notifications: [
                {
                  method: "turn/started",
                  params: { sessionId: "native-session", turn: { id: "recovered" } },
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

        yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
          existingProviderThread: providerThread,
        });
        const recovered = yield* takeEvent("provider_turn.updated");
        expect(recovered.providerTurn).toMatchObject({
          nativeTurnRef: { nativeId: "recovered" },
          ordinal: 3,
          status: "running",
        });
        yield* runtime.interruptTurn({ providerThread, providerTurnId: recovered.providerTurn.id });
        expect(yield* vibe.takeRequest("turn/interrupt")).toMatchObject({
          expectedTurnId: "recovered",
        });
        yield* notify("turn/started", { turn: { id: "recovered" } });
        yield* notify("turn/interrupted", { turn: { id: "recovered" } });
        expect((yield* takeEvent("provider_turn.updated")).providerTurn).toMatchObject({
          ordinal: 3,
          status: "interrupted",
        });

        const providerTurn = snapshot.providerTurns[1]!;
        const rewoundSnapshot = yield* runtime.rollbackThread({
          providerThread,
          providerThreadTurns: snapshot.providerTurns,
          target: {
            type: "provider_turn",
            providerTurn,
            appRunOrdinal: 2,
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
