import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

class Incremented extends Domain.Event("Incremented", { by: Schema.Number }) {}
class Increment extends Domain.Command("Increment", {
  target: Schema.String,
  input: { by: Schema.Number },
  events: [Incremented],
}) {}
class Counter extends Domain.Aggregate("Counter", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Increment],
  decide: { Increment: (_, { by }) => [new Incremented({ by })] },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class Counters extends Domain.Model("Counters", { aggregates: [Counter], views: [Totals] }) {}
class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment"],
  views: ["Totals"],
}) {}

const Hosted = Counters.layer(Layer.empty).pipe(Layer.provide(InMemory));
const InProcess = Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
  Layer.provideMerge(Hosted),
);
// The Api's `fetch` on a real HTTP server, and a client over the wire protocol.
const Wire = CounterApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp("")),
  Layer.provideMerge(
    Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  ),
  Layer.provideMerge(Hosted),
);

/** Each read that takes `atLeast`, waiting for a version the view never reaches. */
const neverCaughtUp = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  const receipt = yield* api.Increment("c-3", { by: 1 });
  const atLeast = { stream: receipt.stream, version: receipt.version + 1 };
  return yield* Effect.all(
    [
      Effect.flip(api.Totals.snapshot("c-3", { atLeast })),
      Effect.flip(api.Totals.get("c-3", { atLeast })),
      Effect.flip(api.Totals.list("c-3", { atLeast })),
    ],
    { concurrency: "unbounded" },
  );
});

/** A snapshot, two writes, then a feed that resumes after the snapshot's cursor. */
const snapshotThenFeed = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  const first = yield* api.Increment("c-1", { by: 1 });
  const snapshot = yield* api.Totals.snapshot("c-1", {
    atLeast: { stream: first.stream, version: first.version },
  });
  // Written after the snapshot, before the feed starts.
  yield* api.Increment("c-1", { by: 2 });
  const last = yield* api.Increment("c-1", { by: 3 });
  const entries = yield* api.Totals.events("c-1", { after: snapshot.cursor }).pipe(
    Stream.filter(Domain.Read.isEvent),
    Stream.take(2),
    Stream.runCollect,
  );
  const now = yield* api.Totals.get("c-1", {
    atLeast: { stream: last.stream, version: last.version },
  });
  return { snapshot, entries, now };
});

describe("Domain View reads", { tags: ["unit", "local"] }, () => {
  it.live("gives the state and the cursor it is valid at", () =>
    Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      expect(yield* api.Totals.snapshot("c-0")).toEqual({ state: null, cursor: 0 });
      const receipt = yield* api.Increment("c-1", { by: 4 });
      const snapshot = yield* api.Totals.snapshot("c-1", {
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      const page = yield* api.Totals.list("c-1", { order: "desc", take: 1 });
      expect(snapshot).toEqual({ state: { total: 4 }, cursor: 1 });
      expect(page.entries[0]!.envelope.seq).toBe(snapshot.cursor);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("writes between the snapshot and the feed arrive once each", () =>
    Effect.gen(function* () {
      const { snapshot, entries, now } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({ state: { total: 1 }, cursor: 1 });
      expect(entries.map((entry) => entry.envelope.seq)).toEqual([2, 3]);
      // The snapshot's state plus the feed is the current state: no gap, nothing twice.
      expect(entries.at(-1)!.state).toEqual(now);
      expect(snapshot.state!.total + entries.reduce((sum, e) => sum + e.event.by, 0)).toBe(
        now!.total,
      );
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("works over the wire", () =>
    Effect.gen(function* () {
      const { snapshot, entries } = yield* snapshotThenFeed;
      expect(snapshot).toEqual({ state: { total: 1 }, cursor: 1 });
      expect(entries.map((entry) => entry.envelope.seq)).toEqual([2, 3]);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("list waits for a write with atLeast, like get", () =>
    Effect.gen(function* () {
      const api = yield* CounterApi.Client;
      const receipt = yield* api.Increment("c-2", { by: 5 });
      const page = yield* api.Totals.list("c-2", {
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      expect(page.entries.map((entry) => entry.state)).toEqual([{ total: 5 }]);
    }).pipe(Effect.provide(InProcess)),
  );

  it.live("a read whose atLeast is never reached fails with ConsistencyTimeout", () =>
    Effect.gen(function* () {
      const [inProcess, overTheWire] = yield* Effect.all(
        [
          neverCaughtUp.pipe(Effect.provide(InProcess)),
          neverCaughtUp.pipe(Effect.scoped, Effect.provide(Wire)),
        ],
        { concurrency: "unbounded" },
      );
      for (const error of [...inProcess, ...overTheWire]) {
        expect(error).toMatchObject({
          _tag: "ConsistencyTimeout",
          view: "Totals",
          key: "c-3",
          version: 2,
        });
      }
    }),
  );
});
