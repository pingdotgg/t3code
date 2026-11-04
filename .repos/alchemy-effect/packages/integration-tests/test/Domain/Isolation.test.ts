import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

// One aggregate and one view definition, used by two independent models.
class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Open],
  decide: { Open: (_, { owner }) => [new Opened({ owner })] },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}
class Owners extends Domain.View("Owners", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}

class Billing extends Domain.Model("Billing", { aggregates: [Account], views: [Owners] }) {}
class Audit extends Domain.Model("Audit", { aggregates: [Account], views: [Owners] }) {}

// One saga definition, run by two independent models.
class OpenAccount extends Domain.Saga("OpenAccount", {
  key: Schema.String,
  input: { owner: Schema.String },
}) {}
const OpenAccountLive = OpenAccount.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ key, owner }) {
      yield* Activity.make({
        name: "open",
        execute: accounts.send(key, new Open({ owner })).pipe(Effect.asVoid),
      });
    });
  }),
);
class Sales extends Domain.Model("Sales", { aggregates: [Account], sagas: [OpenAccount] }) {}
class Support extends Domain.Model("Support", { aggregates: [Account], sagas: [OpenAccount] }) {}

describe("Domain model isolation", () => {
  it.live("two models with the same definitions on one platform keep separate data", () =>
    Effect.gen(function* () {
      const platform = yield* Layer.build(InMemory);
      const billing = yield* Layer.build(Billing.layer(Layer.empty)).pipe(Effect.provide(platform));
      const audit = yield* Layer.build(Audit.layer(Layer.empty)).pipe(Effect.provide(platform));

      const receipt = yield* Context.get(billing, Account).send("a-1", new Open({ owner: "sam" }));
      const atLeast = { stream: receipt.stream, version: receipt.version };

      expect(yield* Context.get(billing, Account).state("a-1")).toEqual({ owner: "sam" });
      expect(yield* Context.get(billing, Owners).query(Account.ref("a-1"), { atLeast })).toEqual(
        Option.some({ owner: "sam" }),
      );
      expect(yield* Context.get(audit, Account).state("a-1")).toEqual({ owner: null });
      expect(yield* Context.get(audit, Owners).query(Account.ref("a-1"))).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );

  it.live("two models running the same saga keep separate runs", () =>
    Effect.gen(function* () {
      const platform = yield* Layer.build(InMemory);
      const sales = yield* Layer.build(Sales.layer(OpenAccountLive)).pipe(Effect.provide(platform));
      const support = yield* Layer.build(Support.layer(OpenAccountLive)).pipe(
        Effect.provide(platform),
      );

      // the same key in both models: two runs, each with its own input
      const salesRun = yield* Context.get(sales, OpenAccount).start("s-1", { owner: "sam" });
      const supportRun = yield* Context.get(support, OpenAccount).start("s-1", { owner: "alex" });
      yield* salesRun.result;
      yield* supportRun.result;

      expect(yield* Context.get(sales, Account).state("s-1")).toEqual({ owner: "sam" });
      expect(yield* Context.get(support, Account).state("s-1")).toEqual({ owner: "alex" });
    }).pipe(Effect.scoped),
  );

  it.effect("hosting two models with the same name on one platform fails", () =>
    Effect.gen(function* () {
      class Duplicate extends Domain.Model("Billing", { aggregates: [Account] }) {}
      const platform = yield* Layer.build(InMemory);
      yield* Layer.build(Billing.layer(Layer.empty)).pipe(Effect.provide(platform));
      const exit = yield* Layer.build(Duplicate.layer(Layer.empty)).pipe(
        Effect.provide(platform),
        Effect.exit,
      );
      expect(String(exit)).toContain(
        "Model Billing is hosted twice on one platform: give each model its own name",
      );
    }).pipe(Effect.scoped),
  );
});
