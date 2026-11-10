import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpGatewayBrokerModule from "../mcp/McpGatewayBroker.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { cascadeToOtherEnvironments } from "./RemoteSettlementCascade.ts";

const devBox = EnvironmentId.make("environment-dev-box");
const macBook = EnvironmentId.make("environment-macbook");
const settledAt = DateTime.makeUnsafe("2026-10-22T10:00:00.000Z");
const iso = (offsetMs: number) =>
  DateTime.formatIso(DateTime.add(settledAt, { milliseconds: offsetMs }));

/** The card on dev-box: one sub-run aged out on its own, one still working. */
const localChildren: Record<string, ReadonlyArray<Partial<OrchestrationV2AppThread>>> = {
  card: [
    {
      id: ThreadId.make("aged"),
      parentEnvironmentId: null,
      settledOverride: "settled",
      settledAt: DateTime.subtract(settledAt, { days: 1 }),
    },
    {
      id: ThreadId.make("busy"),
      parentEnvironmentId: null,
      settledOverride: null,
      settledAt: null,
    },
  ],
};

const remote = (
  id: string,
  parentThreadId: string,
  settled: string | null,
  parentEnv = devBox,
) => ({
  id,
  parentThreadId,
  parentEnvironmentId: parentEnv,
  settledAt: settled,
});

const macBookThreads = [
  remote("under-card", "card", null),
  remote("settled-with-card", "card", iso(2_000)),
  remote("settled-before-card", "card", iso(-3_600_000)),
  remote("under-aged", "aged", null),
  remote("under-busy", "busy", null),
  // The same parent ID, but a parent on yet another machine.
  remote("other-parent", "card", null, EnvironmentId.make("environment-elsewhere")),
];

type Call = { readonly method: string; readonly args: ReadonlyArray<unknown> };

const makeLayer = (calls: Array<Call>, scopes: ReadonlyArray<string>) =>
  Layer.mergeAll(
    Layer.effect(
      McpGatewayBroker,
      Effect.gen(function* () {
        const broker = yield* McpGatewayBrokerModule.make;
        // The desktop app relaying for dev-box reaches the MacBook.
        yield* broker.connect("desktop", { [macBook]: scopes }).pipe(
          Stream.runForEach((event) => {
            calls.push({ method: event.method, args: event.args });
            return broker.respond("desktop", {
              connectionId: event.connectionId,
              invocationId: event.invocationId,
              result:
                event.method === "listThreads"
                  ? { items: macBookThreads, snapshotAt: "now" }
                  : { ok: true },
            });
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
        return broker;
      }),
    ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: devBox } as never),
    }),
    Layer.mock(ProjectionStoreV2)({
      getChildThreads: (parentThreadId) =>
        Effect.succeed((localChildren[parentThreadId] ?? []) as Array<OrchestrationV2AppThread>),
    }),
  );

const targets = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.method === "settleThread" || call.method === "unsettleThread")
    .map((call) => `${call.method}:${String(call.args[0])}:${String(call.args[1])}`)
    .toSorted();

it.effect("a card settles its children on other environments, through settled sub-runs", () => {
  const calls: Array<Call> = [];
  return Effect.gen(function* () {
    yield* cascadeToOtherEnvironments([
      { threadId: ThreadId.make("card"), action: "settle", settledAt },
    ]);
    // A working sub-run's remote children wait for that sub-run's own settle.
    expect(targets(calls)).toEqual([
      `settleThread:${macBook}:settled-before-card`,
      `settleThread:${macBook}:settled-with-card`,
      `settleThread:${macBook}:under-aged`,
      `settleThread:${macBook}:under-card`,
    ]);
  }).pipe(Effect.provide(makeLayer(calls, ["read", "lifecycle"])));
});

it.effect("un-settling a card brings back only remote children that settled with it", () => {
  const calls: Array<Call> = [];
  return Effect.gen(function* () {
    yield* cascadeToOtherEnvironments([
      { threadId: ThreadId.make("card"), action: "unsettle", settledAt },
    ]);
    expect(targets(calls)).toEqual([`unsettleThread:${macBook}:settled-with-card`]);
  }).pipe(Effect.provide(makeLayer(calls, ["read", "lifecycle"])));
});

it.effect("an app without lifecycle access is not asked to settle anything", () => {
  const calls: Array<Call> = [];
  return Effect.gen(function* () {
    yield* cascadeToOtherEnvironments([
      { threadId: ThreadId.make("card"), action: "settle", settledAt },
    ]);
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(makeLayer(calls, ["read"])));
});
