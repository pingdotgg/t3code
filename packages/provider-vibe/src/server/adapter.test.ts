import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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

describe("Vibe question callbacks through the adapter", () => {
  it.effect("publishes a question card, returns the answer, and resolves the card", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Effect.addFinalizer(() => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)));
        const stdout = yield* Queue.unbounded<Uint8Array>();
        const responses = yield* Queue.unbounded<Record<string, unknown>>();
        const callbackResults = yield* Queue.unbounded<unknown>();
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
              kill: () =>
                Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
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
                    let result: unknown = {};
                    if (message["method"] === "initialize")
                      result = { serverInfo: { name: "vibe-app-server", version: "3.1.0" } };
                    if (message["method"] === "session/start")
                      result = { state: { session: { id: "native-session", cwd: process.cwd() } } };
                    if (message["method"] === "callback/result")
                      yield* Queue.offer(callbackResults, message["params"]);
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
        const threadId = ThreadId.make("question-thread");
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
        yield* Effect.addFinalizer(() => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)));
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped({ startImmediately: true }),
        );

        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        const takeEvent = (type: ProviderAdapter.ProviderAdapterV2Event["type"]) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(events);
              if (event.type === type) return event;
            }
          });

        yield* send({
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
        expect((yield* Queue.take(responses))["result"]).toEqual({
          callbackId: "native-question",
          accepted: true,
        });

        const card = yield* takeEvent("turn_item.updated");
        const pending = yield* takeEvent("runtime_request.updated");
        if (
          card.type !== "turn_item.updated" ||
          card.turnItem.type !== "user_input_request" ||
          pending.type !== "runtime_request.updated"
        )
          throw new Error("Missing question card");
        expect(pending.runtimeRequest.kind).toBe("user_input");
        expect(card.turnItem.status).toBe("waiting");
        expect(card.turnItem.requestId).toBe(pending.runtimeRequest.id);

        yield* runtime.respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { "question-0": "Yes" },
        });
        expect(yield* Queue.take(callbackResults)).toEqual({
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
      }).pipe(Effect.provide(layerTest)),
    ),
  );
});
