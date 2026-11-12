import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// A wallet whose deposits a policy books in a ledger: the ledger's events have
// their own command id, and the deposit's id as their correlation id.
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: { Deposit: (_, { amount }) => [new Deposited({ amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
  read: {},
}) {}

const BookedFields = { wallet: Schema.String, amount: Schema.Number, at: Schema.DateTimeUtc };
class Booked extends Domain.Event("Booked", BookedFields) {}
class Book extends Domain.Command("Book", {
  target: Schema.String,
  input: BookedFields,
  events: [Booked],
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  commands: [Book],
  decide: { Book: (_, { wallet, amount, at }) => [new Booked({ wallet, amount, at })] },
  evolve: { Booked: (s, e) => ({ total: s.total + e.amount }) },
  read: {},
}) {}

class BookDeposits extends Domain.Policy("BookDeposits", { from: Wallet, on: [Deposited] }) {}
const BookDepositsLive = BookDeposits.toLayer(
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    return Effect.fn(function* ({ source, event, envelope }) {
      yield* ledger.send(
        "main",
        new Book({ wallet: source.id, amount: event.amount, at: envelope.at }),
      );
    });
  }),
);

class Bookings extends Domain.View("Bookings", {
  from: [Ledger],
  key: Ledger,
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  evolve: { Booked: (s) => ({ count: s.count + 1 }) },
}) {}

// A parcel's input names the fields a call's target and command id use.
class Shipped extends Domain.Event("Shipped", { to: Schema.String, ref: Schema.String }) {}
class Ship extends Domain.Command("Ship", {
  target: Schema.String,
  input: { target: Schema.String, commandId: Schema.String },
  events: [Shipped],
  reply: { to: Schema.String, ref: Schema.String },
}) {}
class Parcel extends Domain.Aggregate("Parcel", {
  id: Schema.String,
  state: Schema.Struct({ to: Schema.String, ref: Schema.String }),
  initial: { to: "", ref: "" },
  commands: [Ship],
  decide: { Ship: (_, { target, commandId }) => [new Shipped({ to: target, ref: commandId })] },
  evolve: { Shipped: (_, e) => ({ to: e.to, ref: e.ref }) },
  reply: { Ship: (s) => s },
  read: {},
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Wallet, Ledger, Parcel],
  views: [Bookings],
  policies: [BookDeposits],
}) {}

class BankApi extends Domain.Api("BankApi", {
  model: Bank,
  commands: ["Deposit", "Ship"],
  views: ["Bookings"],
  aggregates: ["Wallet", "Ledger", "Parcel"],
}) {}

const Hosted = Bank.layer(BookDepositsLive).pipe(Layer.provide(InMemory));

// The Api's `fetch` on a real HTTP server; the client speaks the wire protocol to it.
const Wire = Domain.protocolHttp("").pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(BankApi, (api) => HttpServer.serve()(api.fetch))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  ),
  Layer.provideMerge(Hosted),
);

describe("Domain Api over the wire", { tags: ["unit", "local"] }, () => {
  it.live("an input may name its fields target and commandId", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.client;
      const receipt = yield* bank.Ship(
        "p-1",
        { target: "Lisbon", commandId: "ref-7" },
        { commandId: "ship-1" },
      );
      expect(receipt).toMatchObject({
        reply: { to: "Lisbon", ref: "ref-7" },
        stream: "Parcel/p-1",
      });

      const [shipped] = yield* bank.Parcel.events("p-1").pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(shipped!.envelope.commandId).toBe("ship-1");
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("an envelope keeps its command id and correlation id", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.client;
      const local = yield* BankApi.clientInProcess;
      yield* bank.Deposit("w-1", { amount: 5 }, { commandId: "deposit-1" });

      const [wallet] = yield* bank.Wallet.events("w-1").pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(wallet!.envelope).toMatchObject({
        commandId: "deposit-1",
        correlationId: "deposit-1",
      });

      // The policy's command has its own id, and carries the deposit's correlation id.
      const [booked] = yield* bank.Ledger.events("main").pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(booked!.envelope.commandId).not.toBe("deposit-1");
      expect(booked!.envelope.correlationId).toBe("deposit-1");

      const [entry] = yield* bank.Bookings.events("main").pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(entry!.envelope.correlationId).toBe("deposit-1");
      const page = yield* bank.Bookings.list("main");
      expect(page.entries[0]!.envelope.correlationId).toBe("deposit-1");

      // The wire gives what the in-process client gives.
      const [direct] = yield* local.Ledger.events("main").pipe(
        Stream.filter(Domain.Read.isEvent),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(booked!.envelope).toEqual(direct!.envelope);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );
  it.live("a filter on a DateTime field works over the wire", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.client;
      yield* bank.Deposit("w-1", { amount: 5 }, { commandId: "deposit-1" });
      yield* bank.Ledger.events("main").pipe(Stream.take(1), Stream.runCollect);
      const now = yield* DateTime.now;

      const page = yield* bank.Bookings.list("main", { where: { at: { lte: now } } });
      expect(page.entries.map((entry) => entry.event.amount)).toEqual([5]);
      const none = yield* bank.Bookings.list("main", { where: { at: { gt: now } } });
      expect(none.entries).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("a malformed filter is refused before it is evaluated", () =>
    Effect.gen(function* () {
      const bank = yield* BankApi.client;
      yield* bank.Deposit("w-1", { amount: 5 }, { commandId: "deposit-1" });
      yield* bank.Ledger.events("main").pipe(Stream.take(1), Stream.runCollect);

      // `in` takes a list: the filter fails to encode, rather than throwing where it is evaluated.
      const exit = yield* Effect.exit(
        bank.Bookings.list("main", { where: { amount: { in: 5 } } as never }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const cause = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      expect(cause).toContain("Schema validation failed");
      expect(cause).not.toContain("is not a function");
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );

  it.live("a live read whose request does not decode gets a 400", () =>
    Effect.gen(function* () {
      // fetch refuses requests carrying an `upgrade` header; node:http sends
      // them and hands back a refusal response.
      const client = yield* HttpServer.makeTestClient.pipe(
        Effect.provide(NodeHttpClient.layerNodeHttp),
      );
      const response = yield* client.execute(
        HttpClientRequest.get(`/?read=${encodeURIComponent("{not json")}`).pipe(
          HttpClientRequest.setHeader("upgrade", "websocket"),
        ),
      );
      expect(response.status).toBe(400);
    }).pipe(Effect.scoped, Effect.provide(Wire)),
  );
});
