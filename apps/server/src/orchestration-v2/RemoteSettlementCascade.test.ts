import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type GatewayScope,
  type OrchestrationV2AppThread,
  type TailnetDeviceAccess,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpGatewayBrokerModule from "../mcp/McpGatewayBroker.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import {
  CODE_PAIRED_SUBJECT,
  DESKTOP_APP_SUBJECT,
  layerDependencies,
} from "../mcp/McpGatewayBroker.testkit.ts";
import * as Membership from "../peer/Membership.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as RemoteSettlementCascade from "./RemoteSettlementCascade.ts";
import type { RemoteSettlementRequest } from "./SettlementCascade.ts";

const devBox = EnvironmentId.make("environment-dev-box");
const macBook = EnvironmentId.make("environment-macbook");
const card = ThreadId.make("card");
const settledAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");
const iso = (offsetMs: number) =>
  DateTime.formatIso(DateTime.add(settledAt, { milliseconds: offsetMs }));

const remote = (
  id: string,
  parentThreadId: string,
  settled: string | null,
  parentEnv = devBox,
) => ({ id, parentThreadId, parentEnvironmentId: parentEnv, settledAt: settled });

const macBookThreads = [
  remote("under-card", "card", null),
  remote("settled-with-card", "card", iso(2_000)),
  remote("settled-before-card", "card", iso(-3_600_000)),
  // Under a sub-run the local walk passed through, and under one it did not reach.
  remote("under-aged", "aged", null),
  remote("under-busy", "busy", null),
  // The same parent ID, but a parent on yet another machine.
  remote("other-parent", "card", null, EnvironmentId.make("environment-elsewhere")),
];

type Call = { readonly method: string; readonly args: ReadonlyArray<unknown> };

interface World {
  readonly calls: Array<Call>;
  /** Whether the app reaches the MacBook. */
  reachable: boolean;
  /** The card as this machine's projections hold it now. */
  card: Partial<OrchestrationV2AppThread>;
}

const world = (): World => ({
  calls: [],
  reachable: true,
  card: { id: card, settledOverride: "settled", settledAt, deletedAt: null },
});

const makeLayer = (
  state: World,
  options: {
    readonly scopes?: ReadonlyArray<GatewayScope>;
    readonly self?: TailnetDeviceAccess;
    /** Both machines are full-access members, relayed by dev-box's own desktop app. */
    readonly network?: boolean;
  } = {},
) => {
  const broker = Layer.effect(
    McpGatewayBroker,
    Effect.gen(function* () {
      const broker = yield* McpGatewayBrokerModule.make;
      if (options.network === true) {
        const membership = yield* Membership.Membership;
        for (const environmentId of [devBox, macBook]) {
          yield* membership
            .put({ environmentId, label: environmentId, nodeId: null, access: "full-access" })
            .pipe(Effect.orDie);
        }
      }
      yield* broker
        .connect(
          "desktop",
          { [macBook]: options.scopes ?? ["read", "lifecycle"] },
          options.network === true ? DESKTOP_APP_SUBJECT : CODE_PAIRED_SUBJECT,
        )
        .pipe(
          Stream.runForEach((event) => {
            state.calls.push({ method: event.method, args: event.args });
            return broker.respond("desktop", {
              connectionId: event.connectionId,
              invocationId: event.invocationId,
              ...(!state.reachable
                ? { error: "This T3 app is not connected right now.", unreachable: true as const }
                : event.method === "listThreads"
                  ? { result: { items: macBookThreads, snapshotAt: "now" } }
                  : { result: { ok: true } }),
            });
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
      return broker;
    }),
  );
  return Layer.mergeAll(
    broker,
    EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: devBox } as never),
    }),
    Layer.mock(ProjectionStoreV2)({
      getThread: () => Effect.succeed(state.card as OrchestrationV2AppThread),
    }),
  ).pipe(
    Layer.provideMerge(
      layerDependencies({ environmentId: devBox, ...(options.self && { self: options.self }) }),
    ),
  );
};

/** The effect SettlementCascade queues once its local walk passed through `aged`. */
const request = (action: "settle" | "unsettle"): RemoteSettlementRequest => ({
  type: "thread-settlement.remote",
  action,
  settledAt,
  threadIds: [card, ThreadId.make("aged")],
});
const commandId = CommandId.make("settle-card");
const queue = (action: "settle" | "unsettle") =>
  Effect.flatMap(EffectOutbox.EffectOutboxV2, (outbox) =>
    outbox.enqueue([
      {
        id: "effect:settle-card:thread-settlement.remote",
        commandId,
        threadId: card,
        request: request(action),
      },
    ]),
  );

/** The real worker over an executor that runs only remote settlement, failing after one try. */
const layerWorker = (state: World, options?: Parameters<typeof makeLayer>[1]) =>
  EffectWorker.layerWithOptions({ maxAttempts: 1 }).pipe(
    Layer.provideMerge(
      Layer.effect(
        EffectWorker.OrchestrationEffectExecutorV2,
        Effect.map(RemoteSettlementCascade.make, (cascade) =>
          EffectWorker.OrchestrationEffectExecutorV2.of({
            execute: (effect) =>
              effect.request.type !== "thread-settlement.remote"
                ? Effect.void
                : cascade
                    .run({
                      effectId: effect.id,
                      commandId: effect.commandId,
                      threadId: effect.threadId,
                      request: effect.request,
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new EffectWorker.OrchestrationEffectExecutionError({
                            effectId: effect.id,
                            effectType: effect.request.type,
                            cause,
                          }),
                      ),
                    ),
          }),
        ),
      ),
    ),
    Layer.provideMerge(makeLayer(state, options)),
  );

const targets = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.method === "settleThread" || call.method === "unsettleThread")
    .map((call) => `${call.method}:${String(call.args[0])}:${String(call.args[1])}`)
    .toSorted();

const settledChildren = [
  `settleThread:${macBook}:settled-before-card`,
  `settleThread:${macBook}:settled-with-card`,
  `settleThread:${macBook}:under-aged`,
  `settleThread:${macBook}:under-card`,
];

it.effect("a card settles its children on other environments, through settled sub-runs", () => {
  const state = world();
  return Effect.gen(function* () {
    yield* queue("settle");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    // A working sub-run's remote children wait for that sub-run's own settle.
    expect(targets(state.calls)).toEqual(settledChildren);
  }).pipe(Effect.provide(layerWorker(state)));
});

it.effect("un-settling a card brings back only remote children that settled with it", () => {
  const state = world();
  state.card = { ...state.card, settledOverride: "active", settledAt: null };
  return Effect.gen(function* () {
    yield* queue("unsettle");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    expect(targets(state.calls)).toEqual([`unsettleThread:${macBook}:settled-with-card`]);
  }).pipe(Effect.provide(layerWorker(state)));
});

it.effect("a settle the remote could not take yet runs once it is reachable", () => {
  const state = world();
  state.reachable = false;
  return Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const cascade = yield* RemoteSettlementCascade.make;
    yield* queue("settle");
    yield* worker.drain();
    expect(state.calls.map((call) => call.method)).toEqual(["listThreads"]);
    state.reachable = true;
    yield* cascade.retryWaiting;
    yield* worker.drain();
    expect(targets(state.calls)).toEqual(settledChildren);
    // A retry after the card came back leaves its remote children as they are.
    state.calls.length = 0;
    state.reachable = false;
    yield* EffectOutbox.EffectOutboxV2.pipe(
      Effect.flatMap((outbox) =>
        outbox.enqueue([
          {
            id: "effect:settle-card-again:thread-settlement.remote",
            commandId: CommandId.make("settle-card-again"),
            threadId: card,
            request: request("settle"),
          },
        ]),
      ),
    );
    yield* worker.drain();
    state.card = { ...state.card, settledOverride: "active", settledAt: null };
    state.reachable = true;
    yield* cascade.retryWaiting;
    yield* worker.drain();
    expect(targets(state.calls)).toEqual([]);
  }).pipe(Effect.provide(layerWorker(state)));
});

it.effect("dev-box's own desktop app settles children on a full-access member", () => {
  const state = world();
  return Effect.gen(function* () {
    yield* queue("settle");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    expect(targets(state.calls)).toEqual(settledChildren);
  }).pipe(
    Effect.provide(layerWorker(state, { network: true, scopes: ["read", "create", "send"] })),
  );
});

it.effect("an app without lifecycle access is not asked to settle anything", () => {
  const state = world();
  return Effect.gen(function* () {
    yield* queue("settle");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    expect(state.calls).toEqual([]);
  }).pipe(Effect.provide(layerWorker(state, { scopes: ["read"] })));
});

it.effect("a machine the network lets only read asks no app to settle anything", () => {
  const state = world();
  return Effect.gen(function* () {
    yield* queue("settle");
    yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
    expect(state.calls).toEqual([]);
  }).pipe(Effect.provide(layerWorker(state, { self: "read-only" })));
});
