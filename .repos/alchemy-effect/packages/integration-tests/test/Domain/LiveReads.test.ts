import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  read: {},
}) {}

class Totals extends Domain.View("Totals", {
  from: [Counter],
  key: Counter,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Incremented: (s, e) => ({ total: s.total + e.by }) },
}) {}

class Bumped extends Domain.Event("Bumped", { by: Schema.Number }) {}
class Bumps extends Domain.Stream("Bumps", { key: Counter, entries: [Bumped] }) {}
class BumpWriter extends Domain.Projection("BumpWriter", {
  from: [Counter],
  key: Counter,
  on: [Incremented],
  writes: [Bumps],
}) {}
const BumpWriterLive = BumpWriter.toLayer(
  Effect.gen(function* () {
    const bumps = yield* Bumps;
    return Effect.fn(function* (batch) {
      for (const input of batch) yield* bumps.append(input, new Bumped({ by: input.event.by }));
    });
  }),
);

class Counters extends Domain.Model("Counters", {
  aggregates: [Counter],
  views: [Totals],
  projections: [BumpWriter],
  streams: [Bumps],
}) {}
class CounterApi extends Domain.Api("CounterApi", {
  model: Counters,
  commands: ["Increment"],
  views: ["Totals"],
  streams: ["Bumps"],
  aggregates: ["Counter"],
}) {}

const Hosted = Counters.layer(BumpWriterLive).pipe(Layer.provideMerge(InMemory));
const InProcess = Layer.effect(CounterApi.Client, CounterApi.clientInProcess).pipe(
  Layer.provideMerge(Hosted),
);
const Wire = CounterApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp("")),
  Layer.provideMerge(
    Layer.unwrap(Effect.map(CounterApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  ),
  Layer.provideMerge(Hosted),
);

type Client = Effect.Success<typeof CounterApi.client>;
type Frame = { readonly envelope: { readonly seq: number } } | Domain.Read.CaughtUp;

/** A key's live reads, the same for an aggregate, a view and a stream. */
interface LiveReads {
  readonly watch: (key: string) => Stream.Stream<{ readonly cursor: number }, unknown>;
  readonly events: (key: string, after?: number) => Stream.Stream<Frame, unknown>;
}

const readsOf = (api: Client): Record<"aggregate" | "view" | "stream", LiveReads> => ({
  aggregate: {
    watch: (key: string) => api.Counter.watch(key),
    events: (key: string, after?: number) => api.Counter.events(key, { after }),
  },
  view: {
    watch: (key: string) => api.Totals.watch(key),
    events: (key: string, after?: number) => api.Totals.events(key, { after }),
  },
  stream: {
    watch: (key: string) => api.Bumps.watch(key),
    events: (key: string, after?: number) => api.Bumps.events(key, { after }),
  },
});

/** Wait until the view and the stream have caught up to `version` commits of c-1. */
const settled = (api: Client, version: number) =>
  Effect.all([
    api.Totals.get("c-1", { atLeast: { stream: "Counter/c-1", version } }),
    api.Bumps.peek("c-1", { atLeast: { stream: "Counter/c-1", version } }),
  ]);

/** Three increments of c-1, folded by the view and appended to the stream. */
const seed = Effect.gen(function* () {
  const api = yield* CounterApi.Client;
  for (const by of [1, 2, 3]) yield* api.Increment("c-1", { by });
  yield* settled(api, 3);
  return api;
});

/** What a feed shows: entries by seq, and each CaughtUp by its cursor. */
const frames = (items: ReadonlyArray<Frame>) =>
  items.map((item) =>
    Domain.Read.isCaughtUp(item) ? `caught up at ${item.cursor}` : item.envelope.seq,
  );

for (const [transport, layer] of [
  ["in process", InProcess],
  ["over the wire", Wire],
] as const) {
  describe(`Domain live reads ${transport}`, { tags: ["unit", "local"] }, () => {
    for (const kind of ["aggregate", "view", "stream"] as const) {
      it.live(`${kind} events mark the end of their history`, () =>
        Effect.gen(function* () {
          const api = yield* seed;
          const read = readsOf(api)[kind];
          const feed = yield* read
            .events("c-1")
            .pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("30 millis");
          yield* api.Increment("c-1", { by: 4 });
          yield* settled(api, 4);
          expect(frames(yield* Fiber.join(feed))).toEqual([1, 2, 3, "caught up at 3", 4]);

          // Resuming after a cursor: the rest of the history, nothing twice, no gap.
          const resumed = yield* read.events("c-1", 2).pipe(Stream.take(3), Stream.runCollect);
          expect(frames(resumed)).toEqual([3, 4, "caught up at 4"]);

          const empty = yield* read.events("c-0").pipe(Stream.take(1), Stream.runCollect);
          expect(frames(empty)).toEqual(["caught up at 0"]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );

      it.live(`${kind} watch gives a cursor that hands off to events`, () =>
        Effect.gen(function* () {
          const api = yield* seed;
          const read = readsOf(api)[kind];
          const watched = yield* read
            .watch("c-1")
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("30 millis");
          yield* api.Increment("c-1", { by: 4 });
          const [first, second] = yield* Fiber.join(watched);
          expect([first!.cursor, second!.cursor]).toEqual([3, 4]);

          // From the first state's cursor, events sends only what came after it.
          const after = yield* read
            .events("c-1", first!.cursor)
            .pipe(Stream.take(2), Stream.runCollect);
          expect(frames(after)).toEqual([4, "caught up at 4"]);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );
    }

    it.live("a filter that drops the last entries of the history still ends it", () =>
      Effect.gen(function* () {
        const api = yield* seed;
        const feed = yield* api.Totals.events("c-1", { where: { by: { lt: 3 } } }).pipe(
          Stream.take(3),
          Stream.runCollect,
        );
        expect(frames(feed)).toEqual([1, 2, "caught up at 3"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );

    it.live("watch sends the state with its cursor", () =>
      Effect.gen(function* () {
        const api = yield* seed;
        const [aggregate] = yield* api.Counter.watch("c-1").pipe(Stream.take(1), Stream.runCollect);
        const [view] = yield* api.Totals.watch("c-1").pipe(Stream.take(1), Stream.runCollect);
        const [stream] = yield* api.Bumps.watch("c-1").pipe(Stream.take(1), Stream.runCollect);
        expect(aggregate).toEqual({ state: { total: 6 }, cursor: 3 });
        expect(view).toEqual({ state: { total: 6 }, cursor: 3 });
        expect(stream!.state?.event).toEqual(new Bumped({ by: 3 }));
        expect(stream!.cursor).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
}
