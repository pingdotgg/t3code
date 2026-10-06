import type { Event } from "@kilocode/sdk/v2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { KiloSessionError } from "../../provider/kilo/KiloSessionClient.ts";
import type { KiloConnection } from "../../provider/kilo/KiloRuntime.ts";
import type * as Adapter from "../ProviderAdapter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as KiloAdapter from "./KiloAdapterV2.ts";

it.effect.each(["reconnect", "uncertain admission", "reconnect completion"] as const)(
  "clears the local session warning after %s",
  (scenario) =>
    Effect.gen(function* () {
      const disconnected = yield* Deferred.make<void>();
      const unhealthy = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<void>();
      const incoming = yield* Queue.unbounded<Event>();
      const seen: Array<Adapter.ProviderAdapterV2Event> = [];
      let subscriptions = 0;
      let messageID = "";
      let completed = false;
      const instanceId = ProviderInstanceId.make("kilo-session-status");
      const threadId = ThreadId.make("kilo-status-thread");
      const modelSelection = { instanceId, model: "fixture/test" };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: "/fixture",
      };
      const native = { instanceId: "fixture", directory: "/fixture", sessionId: "ses_fixture" };
      const client = {
        create: () => Effect.succeed(native),
        read: () => Effect.succeed({}),
        setPermissions: () => Effect.void,
        pending: () => Effect.succeed([]),
        status: () => Effect.succeed("idle"),
        history: () =>
          Effect.succeed(
            completed
              ? [
                  {
                    info: {
                      id: messageID,
                      sessionID: native.sessionId,
                      role: "user",
                      time: { created: 1 },
                    },
                    parts: [],
                  },
                  {
                    info: {
                      id: "assistant",
                      parentID: messageID,
                      sessionID: native.sessionId,
                      role: "assistant",
                      time: { created: 2, completed: 3 },
                    },
                    parts: [],
                  },
                ]
              : [],
          ),
        prompt: (_ref: unknown, input: { messageID: string }) => {
          messageID = input.messageID;
          return scenario === "uncertain admission"
            ? Effect.fail(
                new KiloSessionError({ operation: "prompt", reason: "admission_unknown" }),
              )
            : Effect.void;
        },
        events: (_ref: unknown, onConnected: Effect.Effect<void, KiloSessionError>) =>
          Stream.unwrap(
            Effect.gen(function* () {
              subscriptions += 1;
              yield* onConnected;
              return scenario !== "uncertain admission" && subscriptions === 1
                ? Stream.fromEffect(
                    Deferred.await(disconnected).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new KiloSessionError({ operation: "stream", reason: "request_failed" }),
                        ),
                      ),
                    ),
                  )
                : Stream.fromQueue(incoming);
            }),
          ),
      } as unknown as KiloConnection["client"];
      const adapter = yield* KiloAdapter.make({
        instanceId,
        continuationKey: "fixture",
        cwd: "/fixture",
        runtime: {
          open: () =>
            Effect.succeed({
              client,
              stop: Effect.void,
              cleanup: Effect.void,
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
            }),
        },
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("kilo-status-session"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            seen.push(event);
            if (event.type === "provider_session.updated") {
              if (event.providerSession.status !== "ready")
                yield* Deferred.succeed(unhealthy, undefined);
              else yield* Deferred.succeed(recovered, undefined);
            }
            if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      if (scenario === "reconnect") {
        yield* Deferred.succeed(disconnected, undefined);
        yield* Deferred.await(unhealthy);
        yield* TestClock.adjust("1 second");
      } else {
        yield* session.startTurn({
          threadId,
          appThread: { id: threadId },
          providerThread,
          modelSelection,
          runtimePolicy,
          rootNodeId: NodeId.make("root"),
          runId: RunId.make("run"),
          attemptId: RunAttemptId.make("attempt"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          message: { messageId: "message", text: "Hello", attachments: [] },
        } as unknown as Adapter.ProviderAdapterV2TurnInput);
        if (scenario === "reconnect completion") yield* Deferred.succeed(disconnected, undefined);
        yield* Deferred.await(unhealthy);
        completed = true;
        if (scenario === "reconnect completion") {
          yield* TestClock.adjust("1 second");
        } else {
          yield* Queue.offer(incoming, {
            type: "message.updated",
            properties: {
              info: {
                id: messageID,
                sessionID: native.sessionId,
                role: "user",
                time: { created: 1 },
              },
            },
          } as Event);
          yield* Queue.offer(incoming, {
            id: "idle",
            type: "session.idle",
            properties: { sessionID: native.sessionId },
          });
        }
        yield* Deferred.await(terminal);
        assert.isBelow(
          seen.findIndex(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "ready",
          ),
          seen.findIndex((event) => event.type === "turn.terminal"),
        );
      }
      yield* Deferred.await(recovered);
      const updates = seen.filter((event) => event.type === "provider_session.updated");
      assert.equal(updates.at(-1)?.providerSession.status, "ready");
      assert.equal(updates.at(-1)?.providerSession.lastError, null);
      assert.equal(
        updates[0]?.providerSession.status,
        scenario === "uncertain admission" ? "waiting" : "error",
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer))),
);
