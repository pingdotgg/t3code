import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as LiveVoice from "./LiveVoice.ts";

const threadId = ThreadId.make("voice-thread");
const owner = AuthSessionId.make("owner");
const input = (id: string) => ({ threadId, sessionId: id, voice: "sol", sdp: id });
const fixture = Effect.fn("test.liveVoice.fixture")(function* (
  delayed = false,
  events: ReadonlyArray<string> = [],
  delayedValidation = false,
) {
  const validating = yield* Deferred.make<void>();
  const validated = yield* Deferred.make<void>();
  const settled = yield* Deferred.make<void>();
  let reads = 0;
  const opened = yield* Queue.unbounded<string>();
  const ready = yield* Deferred.make<void>();
  if (!delayed) yield* Deferred.succeed(ready, undefined);
  const closed = yield* Queue.unbounded<string>();
  const commands = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const instance = {
    enabled: true,
    instanceId: ProviderInstanceId.make("codex"),
    snapshot: {
      getSnapshot: Effect.succeed({
        auth: { status: "authenticated", accountLabel: "same-account" },
      }),
    },
    liveVoice: {
      options: Effect.succeed({ voices: ["sol"], defaultVoice: "sol" }),
      open: (request: { sdp: string }) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Queue.offer(closed, request.sdp));
          yield* Queue.offer(opened, request.sdp);
          yield* Deferred.await(ready);
          return {
            sdp: "answer",
            events: events.length
              ? Stream.fromIterable(events).pipe(
                  Stream.ensuring(Deferred.succeed(settled, undefined)),
                )
              : Stream.never,
            send: () => Effect.void,
          };
        }),
    },
  } as unknown as ProviderInstance;
  const selected = yield* Ref.make(instance);
  const projection = {
    thread: {
      id: threadId,
      archivedAt: null,
      modelSelection: { instanceId: instance.instanceId, model: "gpt-6-luna" },
    },
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const dependencies = Layer.mergeAll(
    Layer.mock(Providers.ProviderInstanceRegistry, { getInstance: () => Ref.get(selected) }),
    Layer.mock(Projections.ProjectionStoreV2, {
      getThreadSnapshotWindow: () =>
        Effect.gen(function* () {
          if (delayedValidation && ++reads > 1) {
            yield* Deferred.succeed(validating, undefined);
            yield* Deferred.await(validated);
          }
          return { schemaVersion: 2 as const, snapshotSequence: 0, projection };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2, {
      dispatch: (command) =>
        Ref.update(commands, (values) => [...values, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
      streamStoredEventsFrom: () => Stream.never,
    }),
  );
  return {
    layer: LiveVoice.layer.pipe(Layer.provide(dependencies)),
    ready,
    validating,
    validated,
    settled,
    opened,
    closed,
    commands,
    selected,
    instance,
  };
});

it.effect("stops only the owning client's session and closes it when its account changes", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* LiveVoice.LiveVoice;
      yield* service.start(input("first"), owner);
      const denied = yield* service.stop("first", AuthSessionId.make("other")).pipe(Effect.flip);
      assert.equal(denied.reason, "expired");
      yield* Ref.set(test.selected, { ...test.instance });
      const state = yield* service.poll("first", owner, 0);
      assert.equal(state.phase, "error");
      assert.equal(yield* Queue.take(test.closed), "first");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("a cancelled startup cannot release a newer session's reservation", () =>
  Effect.gen(function* () {
    const test = yield* fixture(true);
    yield* Effect.gen(function* () {
      const service = yield* LiveVoice.LiveVoice;
      const first = yield* service.start(input("first"), owner).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(test.opened), "first");
      yield* service.stop("first", owner);
      const second = yield* service.start(input("second"), owner).pipe(Effect.forkChild);
      assert.equal(yield* Queue.take(test.opened), "second");
      yield* Deferred.succeed(test.ready, undefined);
      assert.equal((yield* Fiber.join(first).pipe(Effect.flip)).reason, "expired");
      yield* Fiber.join(second);
      const third = yield* service.start(input("third"), owner).pipe(Effect.flip);
      assert.equal(third.reason, "busy");
      yield* service.stop("second", owner);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("expires a disconnected client's session without a stop request", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const service = yield* LiveVoice.LiveVoice;
      yield* service.start(input("first"), owner);
      yield* TestClock.adjust("50 seconds");
      assert.equal(yield* Queue.take(test.closed), "first");
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("dispatches a repeated voice delegation only once through the normal orchestrator", () =>
  Effect.gen(function* () {
    const delegation = JSON.stringify({
      type: "delegation.created",
      item: {
        id: "request-1",
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: "Check the build" }],
      },
    });
    const test = yield* fixture(false, [delegation, delegation]);
    yield* Effect.gen(function* () {
      const service = yield* LiveVoice.LiveVoice;
      yield* service.start(input("first"), owner);
      yield* Queue.take(test.closed);
      assert.deepEqual(yield* Ref.get(test.commands), [
        {
          type: "message.dispatch",
          commandId: "voice:first:request-1",
          messageId: "voice:first:request-1",
          threadId,
          createdBy: "user",
          creationSource: "web",
          text: "Check the build",
          attachments: [],
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        },
      ]);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("stops a delegation waiting for thread validation before it can dispatch work", () =>
  Effect.gen(function* () {
    const test = yield* fixture(
      false,
      [
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "cancelled-request",
            type: "delegation",
            target: "client",
            content: [{ type: "input_text", text: "Check the build" }],
          },
        }),
      ],
      true,
    );
    yield* Effect.gen(function* () {
      const service = yield* LiveVoice.LiveVoice;
      yield* service.start(input("first"), owner);
      yield* Deferred.await(test.validating);
      yield* service.stop("first", owner);
      yield* Deferred.succeed(test.validated, undefined);
      yield* Deferred.await(test.settled);
      assert.deepEqual(yield* Ref.get(test.commands), []);
    }).pipe(Effect.provide(test.layer));
  }),
);
