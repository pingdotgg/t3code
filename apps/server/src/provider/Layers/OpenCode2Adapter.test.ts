import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
        // `startSession` awaits `firstConnection` (10s budget) before
        // returning, so by the time it resolves the gate is already done —
        // the await below is a no-op proof of that ordering. (The suite runs
        // under a frozen TestClock, so Effect-level timeouts never elapse;
        // the vitest timeout below is the hang guard instead.)
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
        // `startSession` now awaits the `firstConnection` gate (10s budget)
        // before returning, and the gate only resolves after the pump's
        // 250ms TestClock backoff + resubscribe. Fork the start and drive
        // virtual time until it joins — adjusting the clock from the main
        // fiber while blocked inside `startSession` would deadlock.
        const driveStart = Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            adapter.startSession({ threadId, runtimeMode: "full-access" }),
          );
          for (let step = 0; step < 200; step += 1) {
            yield* Effect.yieldNow;
            if (yield* Effect.sync(() => fiber.pollUnsafe() !== undefined)) {
              break;
            }
            yield* TestClock.adjust(Duration.millis(100));
          }
          return yield* Fiber.join(fiber);
        });
        yield* Effect.acquireRelease(driveStart, () => adapter.stopAll().pipe(Effect.ignore));
        const context = resubscribeHarness.store.get(threadId);
        NodeAssert.ok(context !== undefined);
        // The resubscribed feed's `server.connected` frame resolved the gate
        // (start returned only after it did): the pump reconnected through
        // the adapter's resubscribe closure at least once.
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

const gateHarness = makeHarness("oc2-adapter-gate-");

it.layer(gateHarness.TestLayer)("OpenCode2AdapterConnectionGate", (it) => {
  it.effect(
    "startSession fails typed when the event stream never connects",
    () =>
      Effect.gen(function* () {
        // Subscribe parks forever (until the session scope aborts it): no
        // live frame ever arrives, so the 10s connection gate must fail the
        // start instead of returning a dead-but-ready session.
        const parkedClient = (): OpenCode2SessionClient => {
          const base = makeClient();
          return {
            ...base,
            event: {
              subscribe: (options?: { readonly signal?: AbortSignal | undefined }) =>
                Promise.resolve({
                  stream: (async function* () {
                    yield await new Promise<{ type: string }>((_, reject) => {
                      if (options?.signal?.aborted) {
                        reject(new Error("aborted"));
                        return;
                      }
                      options?.signal?.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        {
                          once: true,
                        },
                      );
                    });
                  })(),
                }),
            },
          };
        };
        const adapter = yield* Effect.gen(function* () {
          const queued = yield* TestEvents;
          return yield* makeOpenCode2Adapter(settings, undefined, {
            store: gateHarness.store,
            events: queued,
            createClient: () => Effect.succeed(parkedClient()),
          });
        });
        const threadId = ThreadId.make("thread-oc2-adapter-gate-timeout");
        const fiber = yield* adapter
          .startSession({ threadId, runtimeMode: "full-access" })
          .pipe(Effect.flip, Effect.forkChild);
        for (let step = 0; step < 150; step += 1) {
          yield* Effect.yieldNow;
          if (yield* Effect.sync(() => fiber.pollUnsafe() !== undefined)) {
            break;
          }
          yield* TestClock.adjust(Duration.millis(100));
        }
        const failure = (yield* Fiber.join(fiber)) as {
          readonly _tag: string;
          readonly detail?: unknown;
        };
        NodeAssert.equal(failure._tag, "ProviderAdapterRequestError");
        NodeAssert.match(String(failure.detail), /did not connect within 10 seconds/);
        // The timed-out context is torn down, not left in the store.
        NodeAssert.equal(gateHarness.store.get(threadId), undefined);
        yield* adapter.stopAll().pipe(Effect.ignore);
      }).pipe(Effect.provide(TestClock.layer())),
    10_000,
  );

  it.effect(
    "failed onSessionStart evicts the context instead of leaking it",
    () =>
      Effect.gen(function* () {
        // subscribe rejects synchronously: the pump (forked in the session
        // scope inside onSessionStart) fails, so the start must tear down
        // the published context and close its scope.
        const failingClient = (): OpenCode2SessionClient => {
          const base = makeClient();
          return {
            ...base,
            event: {
              subscribe: () => Promise.reject(new Error("subscribe boom")),
            },
          };
        };
        const adapter = yield* Effect.gen(function* () {
          const queued = yield* TestEvents;
          return yield* makeOpenCode2Adapter(settings, undefined, {
            store: gateHarness.store,
            events: queued,
            createClient: () => Effect.succeed(failingClient()),
          });
        });
        const threadId = ThreadId.make("thread-oc2-adapter-start-failure");
        // A rejected subscribe must surface as a typed
        // `ProviderAdapterRequestError` (not a defect): `Effect.flip` dies
        // on defects, so this fails if the subscribe rejection escapes the
        // typed channel again.
        const failure = (yield* Effect.flip(
          adapter.startSession({ threadId, runtimeMode: "full-access" }),
        )) as {
          readonly _tag: string;
          readonly method?: unknown;
          readonly detail?: unknown;
        };
        NodeAssert.equal(failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(failure.method, "event.subscribe");
        NodeAssert.match(String(failure.detail), /subscribe boom/);
        NodeAssert.equal(gateHarness.store.get(threadId), undefined);
        NodeAssert.equal(yield* adapter.hasSession(threadId), false);
        yield* adapter.stopAll().pipe(Effect.ignore);
      }),
    10_000,
  );
});

const messageIdHarness = makeHarness("oc2-adapter-message-id-");

const mcpHarness = makeHarness("oc2-adapter-mcp-");

it.layer(mcpHarness.TestLayer)("OpenCode2AdapterMcpRemote", (it) => {
  const seedAgentDeviceSession = (threadId: ThreadId) =>
    Effect.sync(() =>
      McpProviderSession.setMcpProviderSession({
        environmentId: "env-test" as never,
        threadId,
        providerSessionId: "provider-session-test",
        providerInstanceId: ProviderInstanceId.make("opencode2"),
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer test-token",
        capabilities: new Set(["device"]),
      }),
    );
  const makeSpyAdapter = (adapterSettings: typeof settings, added: Array<unknown>) =>
    Effect.gen(function* () {
      const queued = yield* TestEvents;
      return yield* makeOpenCode2Adapter(adapterSettings, undefined, {
        store: mcpHarness.store,
        events: queued,
        createClient: () =>
          Effect.succeed({
            ...makeClient(),
            session: {
              ...makeClient().session,
              addMcpServer: (input: unknown) => {
                added.push(input);
                return Promise.resolve(undefined);
              },
            },
          }),
      });
    });

  it.effect(
    "attaches the AgentDevice MCP on spawned (blank serverUrl) servers",
    () =>
      Effect.gen(function* () {
        const added: Array<unknown> = [];
        const adapter = yield* makeSpyAdapter(settings, added);
        const threadId = ThreadId.make("thread-oc2-adapter-mcp-spawned");
        yield* Effect.acquireRelease(
          seedAgentDeviceSession(threadId).pipe(
            Effect.andThen(adapter.startSession({ threadId, runtimeMode: "full-access" })),
          ),
          () =>
            Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)).pipe(
              Effect.andThen(adapter.stopAll().pipe(Effect.ignore)),
            ),
        );
        NodeAssert.equal(added.length, 1);
        const attached = added[0] as { name: string; config: { url: string } };
        NodeAssert.equal(attached.name, "t3-code");
        NodeAssert.equal(attached.config.url, "http://127.0.0.1:1/mcp");
      }),
    10_000,
  );

  it.effect(
    "never forwards the AgentDevice token to external (serverUrl) servers",
    () =>
      Effect.gen(function* () {
        const externalSettings = decodeSettings({
          enabled: true,
          binaryPath: "opencode",
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "",
          customModels: [],
        });
        const added: Array<unknown> = [];
        const adapter = yield* makeSpyAdapter(externalSettings, added);
        const threadId = ThreadId.make("thread-oc2-adapter-mcp-external");
        yield* Effect.acquireRelease(
          seedAgentDeviceSession(threadId).pipe(
            Effect.andThen(adapter.startSession({ threadId, runtimeMode: "full-access" })),
          ),
          () =>
            Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)).pipe(
              Effect.andThen(adapter.stopAll().pipe(Effect.ignore)),
            ),
        );
        NodeAssert.equal(added.length, 0);
      }),
    10_000,
  );
});

it.layer(messageIdHarness.TestLayer)("OpenCode2AdapterMessageIds", (it) => {
  it.effect(
    "sendTurn mints restart-safe unique UUID message ids",
    () =>
      Effect.gen(function* () {
        const seenMessageIds: Array<string> = [];
        const capturingClient = (): OpenCode2SessionClient => {
          const base = makeClient();
          return {
            ...base,
            session: {
              ...base.session,
              promptAsync: (input) => {
                seenMessageIds.push(input.messageID);
                return Promise.resolve(undefined);
              },
            },
          };
        };
        const adapter = yield* Effect.gen(function* () {
          const queued = yield* TestEvents;
          return yield* makeOpenCode2Adapter(settings, undefined, {
            store: messageIdHarness.store,
            events: queued,
            createClient: () => Effect.succeed(capturingClient()),
          });
        });
        const threadId = ThreadId.make("thread-oc2-adapter-message-id");
        yield* Effect.acquireRelease(
          adapter.startSession({ threadId, runtimeMode: "full-access" }),
          () => adapter.stopAll().pipe(Effect.ignore),
        );
        const modelSelection = {
          instanceId: ProviderInstanceId.make("opencode2"),
          model: "anthropic/claude-sonnet",
        };
        yield* adapter.sendTurn({ threadId, input: "first", modelSelection });
        yield* adapter.sendTurn({ threadId, input: "second", modelSelection });
        NodeAssert.equal(seenMessageIds.length, 2);
        for (const messageId of seenMessageIds) {
          NodeAssert.match(
            messageId,
            /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
        }
        NodeAssert.notEqual(seenMessageIds[0], seenMessageIds[1]);
      }),
    10_000,
  );
});
