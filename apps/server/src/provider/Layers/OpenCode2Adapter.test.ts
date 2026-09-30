import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { OpenCode2Settings } from "../OpenCode2Settings.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { OpenCode2AdapterError } from "../opencode2/OpenCode2Protocol.ts";
import {
  makeOpenCode2SessionStore,
  type OpenCode2SessionClient,
} from "../opencode2/OpenCode2SessionStore.ts";

class TestOpenCode2Adapter extends Context.Service<
  TestOpenCode2Adapter,
  ProviderAdapterShape<OpenCode2AdapterError>
>()("t3/provider/Layers/OpenCode2Adapter.test/TestOpenCode2Adapter") {}

const decodeSettings = Schema.decodeSync(OpenCode2Settings);

const settings = decodeSettings({
  enabled: true,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
});

const makeClient = (): OpenCode2SessionClient => ({
  session: {
    create: () => Promise.resolve({ data: { id: "ses_adapter_1", directory: "/work/dir" } }),
    get: () => Promise.reject(Object.assign(new Error("missing"), { status: 404 })),
    list: () => Promise.resolve({ data: [] }),
    fork: () => Promise.resolve({ data: { id: "ses_fork" } }),
    move: () => Promise.resolve({ data: { id: "ses_adapter_1" } }),
    wait: () => Promise.resolve(undefined),
    interrupt: () => Promise.resolve(undefined),
    update: () => Promise.resolve(undefined),
    abort: () => Promise.resolve(undefined),
    switchModel: () => Promise.resolve(undefined),
    switchAgent: () => Promise.resolve(undefined),
    promptAsync: () => Promise.resolve(undefined),
    command: () => Promise.resolve(undefined),
    messages: () => Promise.resolve({ data: [] }),
  },
  permission: { reply: () => Promise.resolve(undefined) },
  question: { reply: () => Promise.resolve(undefined) },
  event: {
    subscribe: (options?: { readonly signal?: AbortSignal | undefined }) =>
      Promise.resolve({
        // One live frame then park on the subscribe signal: proves the pump
        // resolves firstConnection (quality gate) while the fiber stays
        // live, and proves stopAll tears it down — the adapter's abort
        // finalizer rejects the parked read before the pump interrupt
        // (a never-promise here would hang scope close: `iterator.return()`
        // waits for the parked read).
        stream: (async function* () {
          yield { type: "server.connected" };
          yield await new Promise<{ type: string }>((_, reject) => {
            if (options?.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        })(),
      }),
  },
});

class TestEvents extends Context.Service<TestEvents, Queue.Queue<ProviderRuntimeEvent>>()(
  "t3/provider/Layers/OpenCode2Adapter.test/TestEvents",
) {}

/**
 * Fresh store + layer per suite. The store was previously module-level and
 * shared across tests, so one test's sessions (and its `stopAll` queue
 * shutdown) leaked into the next — `store.size() === 1` only held by
 * accident of ordering. Each `it.layer` block builds its own layer scope, so
 * a per-harness store gives full session/queue isolation between tests.
 */
const makeHarness = (prefix: string) => {
  const store = makeOpenCode2SessionStore();
  const TestLayer = Layer.effect(
    TestOpenCode2Adapter,
    Effect.gen(function* () {
      const events = yield* TestEvents;
      return yield* makeOpenCode2Adapter(settings, undefined, {
        store,
        events,
        createClient: () => Effect.succeed(makeClient()),
      });
    }),
  ).pipe(
    Layer.provideMerge(Layer.effect(TestEvents, Queue.unbounded<ProviderRuntimeEvent>())),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { store, TestLayer };
};

const firstConnection = makeHarness("oc2-adapter-firstconn-");
const stopAllHarness = makeHarness("oc2-adapter-stopall-");

it.layer(firstConnection.TestLayer)("OpenCode2AdapterFirstConnection", (it) => {
  it.effect(
    "first live pump frame resolves firstConnection",
    () =>
      Effect.gen(function* () {
        const adapter = yield* TestOpenCode2Adapter;
        const threadId = ThreadId.make("thread-oc2-adapter-firstconn");
        yield* Effect.acquireRelease(
          adapter.startSession({ threadId, runtimeMode: "full-access" }),
          () => adapter.stopAll().pipe(Effect.ignore),
        );
        const context = firstConnection.store.get(threadId);
        NodeAssert.ok(context !== undefined);
        // The `server.connected` frame ran through the pump: the deferred the
        // quality gate flagged as constructed-but-never-completed is done.
        // `startSession` returns before the forked pump fiber consumes the
        // first frame, so await it — the suite runs under a frozen TestClock,
        // so Effect-level timeouts never elapse; the vitest timeout below is
        // the hang guard instead.
        yield* Deferred.await(context.firstConnection);
        NodeAssert.equal(yield* Deferred.isDone(context.firstConnection), true);
      }),
    10_000,
  );
});

it.layer(stopAllHarness.TestLayer)("OpenCode2AdapterStopAll", (it) => {
  it.effect("stopAll drains sessions and shuts the shared queue", () =>
    Effect.gen(function* () {
      const adapter = yield* TestOpenCode2Adapter;
      const events = yield* TestEvents;
      const threadId = ThreadId.make("thread-oc2-adapter-stopall");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      NodeAssert.equal(stopAllHarness.store.size(), 1);
      yield* adapter.stopAll();
      NodeAssert.equal(stopAllHarness.store.size(), 0);
      // The queue is shut: offers fail instead of buffering, and a take
      // on the drained queue fails instead of hanging.
      NodeAssert.equal(yield* Queue.offer(events, {} as ProviderRuntimeEvent), false);
      NodeAssert.equal(yield* Queue.poll(events).pipe(Effect.map(Option.isNone)), true);
    }),
  );
});

const resubscribeHarness = makeHarness("oc2-adapter-resubscribe-");

it.layer(resubscribeHarness.TestLayer)("OpenCode2AdapterResubscribe", (it) => {
  it.effect(
    "pump resubscribes after a drop (adapter-level, fake subscription failing once)",
    () =>
      Effect.gen(function* () {
        let subscribes = 0;
        const freshClient = (): OpenCode2SessionClient => {
          const base = makeClient();
          const failingStreamOnce = {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.reject(new Error("transport drop")),
              } as AsyncIterator<{ type: string }>;
            },
          };
          return {
            ...base,
            event: {
              subscribe: (options?: { readonly signal?: AbortSignal | undefined }) => {
                subscribes += 1;
                if (subscribes === 1) {
                  // First feed drops before its first frame: the pump records
                  // disconnect state then resubscribes via the adapter wiring.
                  return Promise.resolve({ stream: failingStreamOnce });
                }
                return base.event.subscribe(options);
              },
            },
          };
        };
        const events = yield* TestEvents;
        const adapter = yield* Effect.gen(function* () {
          const queued = yield* TestEvents;
          return yield* makeOpenCode2Adapter(settings, undefined, {
            store: resubscribeHarness.store,
            events: queued,
            createClient: () => Effect.succeed(freshClient()),
          });
        });
        const threadId = ThreadId.make("thread-oc2-adapter-resubscribe");
        yield* Effect.acquireRelease(
          adapter.startSession({ threadId, runtimeMode: "full-access" }),
          () => adapter.stopAll().pipe(Effect.ignore),
        );
        const context = resubscribeHarness.store.get(threadId);
        NodeAssert.ok(context !== undefined);
        // The resubscribed feed's `server.connected` frame resolves the gate:
        // the pump reconnected through the adapter's resubscribe closure at
        // least once. The suite runs under a frozen TestClock, so drive
        // virtual time in bounded steps (first backoff is 250ms) until the
        // gate resolves; the vitest timeout is the hang guard.
        for (let step = 0; step < 40; step += 1) {
          yield* Effect.yieldNow;
          if (Option.isSome(yield* Deferred.poll(context.firstConnection))) {
            break;
          }
          yield* TestClock.adjust(Duration.millis(100));
        }
        NodeAssert.equal(Option.isSome(yield* Deferred.poll(context.firstConnection)), true);
        NodeAssert.ok(subscribes >= 2);
        // Disconnect state from the first drop reached the shared queue
        // (warning + reconnectable exit), proving the drop actually happened.
        const drained: Array<ProviderRuntimeEvent> = [];
        let next = yield* Queue.poll(events);
        while (Option.isSome(next)) {
          drained.push(next.value);
          next = yield* Queue.poll(events);
        }
        const types = new Set(drained.map((event) => event.type));
        NodeAssert.ok(types.has("runtime.warning"));
        NodeAssert.ok(types.has("session.exited"));
        const exited = drained.findLast((event) => event.type === "session.exited");
        NodeAssert.deepEqual(
          (exited as unknown as { payload: { recoverable: boolean } }).payload.recoverable,
          true,
        );
      }).pipe(Effect.provide(TestClock.layer())),
    10_000,
  );
});

it.layer(firstConnection.TestLayer)("OpenCode2AdapterHardening", (it) => {
  it.effect(
    "stop evicts the context so the pump reconnect loop exits",
    () =>
      Effect.gen(function* () {
        const adapter = yield* TestOpenCode2Adapter;
        const threadId = ThreadId.make("thread-oc2-adapter-pump-stop");
        yield* Effect.acquireRelease(
          adapter.startSession({ threadId, runtimeMode: "full-access" }),
          () => adapter.stopAll().pipe(Effect.ignore),
        );
        const context = firstConnection.store.get(threadId);
        NodeAssert.ok(context !== undefined);
        yield* Deferred.await(context.firstConnection);
        // Stop evicts the context from the store: the pump's reconnect loop
        // (isOpenCode2PumpStopped) exits on eviction instead of resubscribing
        // forever, and a second stop is a no-op.
        yield* adapter.stopSession(threadId);
        NodeAssert.equal(firstConnection.store.get(threadId), undefined);
        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      }),
    10_000,
  );
});
