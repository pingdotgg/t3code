import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------- a wallet domain

class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Number,
  balance: Schema.Number,
}) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
  reply: { balance: Schema.Number },
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: {
    Deposit: (s, cmd) => [new Deposited({ amount: cmd.amount, balance: s.balance + cmd.amount })],
  },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
}) {}

class Sent extends Domain.Event("Sent", {
  from: Schema.String,
  to: Schema.String,
  amount: Schema.Number,
}) {}
class Send extends Domain.Command("Send", {
  target: Schema.String,
  input: { from: Schema.String, to: Schema.String, amount: Schema.Number },
  events: [Sent],
}) {}
class Payment extends Domain.Aggregate("Payment", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Send],
  decide: { Send: (_, { from, to, amount }) => [new Sent({ from, to, amount })] },
  evolve: { Sent: (s) => s },
}) {}

// ---------------------------------------------------------------- a store you own

interface Row {
  readonly id: string;
  readonly wallet: string;
  readonly kind: "deposit" | "out" | "in";
  readonly amount: number;
}

/** A table outside the model, standing in for a database. */
class Ledger extends Context.Service<
  Ledger,
  {
    readonly upsert: (rows: ReadonlyArray<Row>) => Effect.Effect<void>;
    readonly rows: Effect.Effect<ReadonlyArray<Row>>;
    readonly runs: Effect.Effect<ReadonlyArray<number>>;
  }
>()("Test/Ledger") {
  static readonly memory = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const table = yield* Ref.make(new Map<string, Row>());
      const runs = yield* Ref.make<ReadonlyArray<number>>([]);
      return {
        upsert: (rows) =>
          Ref.update(table, (map) => {
            const next = new Map(map);
            for (const row of rows) next.set(row.id, row);
            return next;
          }).pipe(Effect.andThen(Ref.update(runs, (all) => [...all, rows.length]))),
        rows: Ref.get(table).pipe(Effect.map((map) => [...map.values()])),
        runs: Ref.get(runs),
      };
    }),
  );
}

// A projection with two sources and named routes: a payment lands on both wallets.
class WalletLedger extends Domain.Projection("WalletLedger", {
  from: [Wallet, Payment],
  key: Wallet,
  keyOf: {
    Sent: {
      out: ({ event }) => Wallet.ref(event.from),
      in: ({ event }) => Wallet.ref(event.to),
    },
  },
  on: [Deposited, Sent],
}) {}

const walletLedgerLayer = (options?: Domain.Projection.Options) =>
  WalletLedger.toLayer(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      return Effect.fn(function* (batch) {
        yield* ledger.upsert(
          batch.map(({ key, route, event, envelope }) => ({
            id: `${envelope.stream}:${envelope.seq}:${route ?? ""}`,
            wallet: key.id,
            kind: event._tag === "Deposited" ? "deposit" : (route as "out" | "in"),
            amount: event.amount,
          })),
        );
      });
    }),
    options,
  );

// ---------------------------------------------------------------- a stream the frontend reads

class Viewer extends Domain.RequestContext<Viewer>()("Test/Viewer", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class NotYours extends Domain.Rejection("NotYours") {}
class ViewerSession extends RpcMiddleware.Service<ViewerSession, { provides: Viewer }>()(
  "Test/ViewerSession",
  { error: Unauthenticated },
) {}
const ViewerSessionLive = Layer.succeed(ViewerSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-viewer"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (name) => Effect.provideService(effect, Viewer, name),
  }),
);

class BalanceChanged extends Domain.Event("BalanceChanged", {
  owner: Schema.String,
  balance: Schema.Number,
}) {}

class WalletCard extends Domain.Stream("WalletCard", {
  key: Wallet,
  entries: [BalanceChanged],
  middleware: [ViewerSession],
  rejects: [NotYours],
  validate: Effect.fn(function* (_request, latest) {
    if (latest && latest.event.owner !== (yield* Viewer)) return yield* new NotYours();
  }),
}) {}

class WalletCards extends Domain.Projection("WalletCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}
const WalletCardsLive = WalletCards.toLayer(
  Effect.gen(function* () {
    const cards = yield* WalletCard;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* cards.append(
          input,
          new BalanceChanged({ owner: input.key.id.split("-")[0]!, balance: input.event.balance }),
        );
      }
    });
  }),
);

// ---------------------------------------------------------------- a keyed policy over two sources

class Flagged extends Domain.Event("Flagged", { reason: Schema.String }) {}
class Flag extends Domain.Command("Flag", {
  target: Schema.String,
  input: { reason: Schema.String },
  events: [Flagged],
}) {}
class Review extends Domain.Aggregate("Review", {
  id: Schema.String,
  state: Schema.Struct({ flags: Schema.Number }),
  initial: { flags: 0 },
  commands: [Flag],
  decide: { Flag: (_, cmd) => [new Flagged({ reason: cmd.reason })] },
  evolve: { Flagged: (s) => ({ flags: s.flags + 1 }) },
}) {}

// Keyed by wallet: a deposit and both sides of a payment each run in their wallet's order.
class LargeMovements extends Domain.Policy("LargeMovements", {
  from: [Wallet, Payment],
  key: Wallet,
  keyOf: {
    Sent: {
      out: ({ event }) => Wallet.ref(event.from),
      in: ({ event }) => Wallet.ref(event.to),
    },
  },
  on: [Deposited, Sent],
}) {}
const LargeMovementsLive = LargeMovements.toLayer(
  Effect.gen(function* () {
    const reviews = yield* Review;
    return Effect.fn(function* ({ key, route, event }) {
      if (event.amount < 100) return;
      yield* reviews.send(key.id, new Flag({ reason: `${event._tag}${route ? `:${route}` : ""}` }));
    });
  }),
  { retry: Schedule.recurs(2) },
);

class Wallets extends Domain.Model("Wallets", {
  aggregates: [Wallet, Payment, Review],
  policies: [LargeMovements],
  projections: [WalletLedger, WalletCards],
  streams: [WalletCard],
}) {}

class WalletApi extends Domain.Api("WalletApi", {
  model: Wallets,
  commands: ["Deposit"],
  streams: ["WalletCard"],
}) {}

const handlers = (options?: Domain.Projection.Options) =>
  Layer.mergeAll(walletLedgerLayer(options), WalletCardsLive, LargeMovementsLive);

const story = Story.make(Wallets, { layer: handlers() });
const sam = Wallet.ref("sam-1");
const kim = Wallet.ref("kim-1");
const p1 = Payment.ref("p-1");

describe("Domain Projection", { tags: ["unit", "local"] }, () => {
  it.effect("routes inputs to keys and writes a store you own", () =>
    Effect.gen(function* () {
      yield* story(
        Story.when(sam, new Deposit({ amount: 50 })),
        Story.then(sam, new Deposited({ amount: 50, balance: 50 })),
        Story.when(p1, new Send({ from: "sam-1", to: "kim-1", amount: 20 })),
        Story.then(p1, new Sent({ from: "sam-1", to: "kim-1", amount: 20 })),
      );
      const ledger = yield* Ledger;
      const rows = yield* ledger.rows;
      expect(rows.map((r) => [r.wallet, r.kind, r.amount]).sort()).toEqual([
        ["kim-1", "in", 20],
        ["sam-1", "deposit", 50],
        ["sam-1", "out", 20],
      ]);
    }).pipe(Effect.provide(Ledger.memory)),
  );

  it.effect("history reaches projections", () =>
    Effect.gen(function* () {
      yield* story(Story.given(sam, new Deposited({ amount: 5, balance: 5 })));
      const rows = yield* (yield* Ledger).rows;
      expect(rows.map((r) => r.amount)).toEqual([5]);
    }).pipe(Effect.provide(Ledger.memory)),
  );

  it.effect("appends to a stream, once per input", () =>
    story(
      Story.when(sam, new Deposit({ amount: 50 })),
      Story.then(sam, new Deposited({ amount: 50, balance: 50 })),
      Story.streamed(WalletCard, sam, new BalanceChanged({ owner: "sam", balance: 50 })),
      Story.when(sam, new Deposit({ amount: 25 })),
      Story.then(sam, new Deposited({ amount: 25, balance: 75 })),
      Story.streamed(WalletCard, sam, new BalanceChanged({ owner: "sam", balance: 75 })),
      Story.when(kim, new Deposit({ amount: 1 })),
      Story.then(kim, new Deposited({ amount: 1, balance: 1 })),
      Story.streamed(WalletCard, sam),
    ).pipe(Effect.provide(Ledger.memory)),
  );

  it.effect("a keyed policy runs per route, over two sources", () =>
    story(
      Story.when(sam, new Deposit({ amount: 150 })),
      Story.then(sam, new Deposited({ amount: 150, balance: 150 })),
      Story.then(Review.ref("sam-1"), new Flagged({ reason: "Deposited" })),
      Story.when(p1, new Send({ from: "sam-1", to: "kim-1", amount: 120 })),
      Story.then(p1, new Sent({ from: "sam-1", to: "kim-1", amount: 120 })),
      Story.then(Review.ref("sam-1"), new Flagged({ reason: "Sent:out" })),
      Story.then(Review.ref("kim-1"), new Flagged({ reason: "Sent:in" })),
    ).pipe(Effect.provide(Ledger.memory)),
  );

  it.live("batches a key's inputs and reads your own write with caughtUp", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      for (const amount of [1, 2, 3]) yield* wallets.send(sam, new Deposit({ amount }));
      const receipt = yield* wallets.send(sam, new Deposit({ amount: 4 }));
      yield* WalletLedger.caughtUp(receipt);
      const ledger = yield* Ledger;
      expect((yield* ledger.rows).map((r) => r.amount).sort()).toEqual([1, 2, 3, 4]);
      // Four inputs, batches of up to three: fewer runs than inputs.
      expect((yield* ledger.runs).reduce((a, b) => a + b, 0)).toBe(4);
      expect((yield* ledger.runs).length).toBeLessThan(4);
    }).pipe(
      Effect.provide(
        Wallets.layer(handlers({ batch: { size: 3, wait: "50 millis" } })).pipe(
          Layer.provideMerge(Layer.mergeAll(InMemory, Ledger.memory)),
        ),
      ),
    ),
  );

  it.live("serves a stream through an Api, judged by validate", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      const receipt = yield* wallets.send(sam, new Deposit({ amount: 40 }));
      const api = yield* WalletApi.clientInProcess;
      const asSam = { headers: { "x-viewer": "sam" } };
      const latest = yield* api.WalletCard.peek("sam-1", {
        ...asSam,
        atLeast: { stream: receipt.stream, version: receipt.version },
      });
      expect(latest?.event).toEqual(new BalanceChanged({ owner: "sam", balance: 40 }));
      const refused = yield* api.WalletCard.peek("sam-1", { headers: { "x-viewer": "kim" } }).pipe(
        Effect.flip,
      );
      expect(refused._tag).toBe("NotYours");
      // A read without a session fails with the middleware's error, and the client's type has it.
      const anonymous = yield* api.WalletCard.peek("sam-1").pipe(
        Effect.catchTag("Unauthenticated", (e) => Effect.succeed(e._tag)),
      );
      expect(anonymous).toBe("Unauthenticated");
      yield* wallets.send(sam, new Deposit({ amount: 2 }));
      const all = yield* api.WalletCard.events("sam-1", asSam).pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(2),
        Stream.runCollect,
      );
      expect([...all].map((entry) => entry.event.balance)).toEqual([40, 42]);
      const page = yield* api.WalletCard.list("sam-1", { ...asSam, order: "desc", take: 1 });
      expect(page.entries.map((entry) => entry.event.balance)).toEqual([42]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Wallets.layer(handlers()).pipe(
          Layer.provideMerge(Layer.mergeAll(InMemory, Ledger.memory, ViewerSessionLive)),
        ),
      ),
    ),
  );

  it("refuses a second writer for one stream", () => {
    class AlsoCards extends Domain.Projection("AlsoCards", {
      from: [Wallet],
      key: Wallet,
      on: [Deposited],
      writes: [WalletCard],
    }) {}
    class Broken extends Domain.Model("Broken", {
      aggregates: [Wallet],
      projections: [WalletCards, AlsoCards],
      streams: [WalletCard],
    }) {}
    const exit = Effect.runSyncExit(
      Layer.build(
        Broken.layer(
          Layer.mergeAll(WalletCardsLive, AlsoCards.toLayer(Effect.succeed(() => Effect.void))),
        ),
      ).pipe(Effect.scoped, Effect.provide(InMemory)) as Effect.Effect<unknown>,
    );
    expect(String(exit)).toContain("two writers");
  });
});
