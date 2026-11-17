import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
  decide: { Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })] },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Sent extends Domain.Event("Sent", { to: Schema.String, amount: Schema.Number }) {}
class Send extends Domain.Command("Send", {
  target: Schema.String,
  input: { to: Schema.String, amount: Schema.Number },
  events: [Sent],
}) {}
class Payment extends Domain.Aggregate("Payment", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Send],
  decide: { Send: (_, { to, amount }) => [new Sent({ to, amount })] },
  evolve: { Sent: (s) => s },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

class Card extends Domain.Event("Card", { amount: Schema.Number }) {}
class WalletCard extends Domain.Stream("WalletCard", { key: Wallet, entries: [Card] }) {}
class WalletCards extends Domain.Projection("WalletCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Wallet, Payment],
  views: [Balance],
  projections: [WalletCards],
  streams: [WalletCard],
}) {}

// Payments are keyed by payment id, not by wallet: routing them needs keyOf.
class Received extends Domain.View("Received", {
  from: [Payment],
  key: Wallet,
  state: Schema.Struct({ total: Schema.Number }),
  evolve: { Sent: (s, e) => ({ total: (s?.total ?? 0) + e.amount }) },
}) {}
// Keyed by a branch id rather than an aggregate: a wallet's events name no branch.
const BranchId = Schema.String.pipe(Schema.brand("BranchId"));
class BranchTotals extends Domain.View("BranchTotals", {
  from: [Wallet],
  key: BranchId,
  state: Schema.Struct({ total: Schema.Number }),
  initial: { total: 0 },
  evolve: { Deposited: (s, e) => ({ total: s.total + e.amount }) },
}) {}
// Keyed by branch id, so it cannot write a stream keyed by wallet.
class BranchCard extends Domain.Stream("BranchCard", { key: Wallet, entries: [Card] }) {}
class BranchCards extends Domain.Projection("BranchCards", {
  from: [Wallet],
  key: BranchId,
  keyOf: { Deposited: () => BranchId.make("main") },
  on: [Deposited],
  writes: [BranchCard],
}) {}
class AlsoCards extends Domain.Projection("AlsoCards", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
  writes: [WalletCard],
}) {}
class Broken extends Domain.Model("Broken", {
  aggregates: [Wallet, Payment],
  views: [Received, BranchTotals],
  projections: [WalletCards, AlsoCards, BranchCards],
  streams: [WalletCard, BranchCard],
}) {}

// Notify listens for an event its source never emits, and Audit reads a view
// the model does not host. Ledger's initial state does not fit its schema.
class Notify extends Domain.Policy("Notify", { from: Payment, on: [Deposited] }) {}
class Audit extends Domain.Policy("Audit", { from: Balance, on: [Deposited] }) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ entries: Schema.Number }),
  initial: { entries: "none" } as unknown as { entries: number },
  commands: [],
  decide: {},
  evolve: {},
}) {}
class AlsoBroken extends Domain.Model("AlsoBroken", {
  aggregates: [Wallet, Payment, Ledger],
  policies: [Notify, Audit],
}) {}

const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));
class Opened extends Domain.Event("Opened") {}
class OpenAccount extends Domain.Command("OpenAccount", { target: AccountId, events: [Opened] }) {}
// Addresses a customer, so it does not belong on Account.
class OpenForCustomer extends Domain.Command("OpenForCustomer", {
  target: CustomerId,
  events: [Opened],
}) {}
// A plain string target accepts ids that are not an AccountId.
class OpenAny extends Domain.Command("OpenAny", { target: Schema.String, events: [Opened] }) {}

describe("Domain verify", { tags: ["unit", "local"] }, () => {
  it("finds no problem in a correct model", () => {
    expect(Domain.verify(Bank)).toEqual([]);
  });

  it("returns every definition problem at once", () => {
    expect(Domain.verify(Broken).map((problem) => problem.message)).toEqual([
      "Received declares state without initial",
      "Received consumes 'Sent' from Payment, which is not keyed by Wallet: add keyOf.Sent",
      "BranchTotals consumes 'Deposited' from Wallet, which is not keyed by its key schema: add keyOf.Deposited",
      "WalletCard has two writers, WalletCards and AlsoCards: a stream key has exactly one",
      "Projection BranchCards is keyed by a key schema, so it cannot write BranchCard, keyed by Wallet",
    ]);
  });

  it("goes on past a problem to find the next one", () => {
    expect(Domain.verify(AlsoBroken).map((problem) => problem.message)).toEqual([
      expect.stringContaining("Ledger.initial does not match its state schema"),
      "Policy Notify: none of Payment emits 'Deposited'",
      "Policy Audit consumes Balance, which is not in the Domain",
    ]);
  });

  it("reports the problem that building the model's Layer fails on", () => {
    const [first] = Domain.verify(Broken);
    const exit = Effect.runSyncExit(
      Layer.build(
        Broken.layer(
          Layer.mergeAll(
            WalletCards.toLayer(Effect.succeed(() => Effect.void)),
            AlsoCards.toLayer(Effect.succeed(() => Effect.void)),
            BranchCards.toLayer(Effect.succeed(() => Effect.void)),
          ),
        ),
      ).pipe(Effect.scoped, Effect.provide(InMemory)) as Effect.Effect<unknown>,
    );
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
      _tag: "DefinitionError",
      message: first!.message,
    });
  });

  describe("command target", { tags: ["unit", "local"] }, () => {
    it("a command addresses its aggregate's id", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        commands: [OpenAccount],
        decide: { OpenAccount: () => [new Opened()] },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.ref("a-1").id).toBe("a-1");
    });

    it("a command whose target is another id schema is a type error", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        commands: [
          OpenAccount,
          // @ts-expect-error OpenForCustomer's target must be this aggregate's id schema
          OpenForCustomer,
        ],
        decide: { OpenAccount: () => [new Opened()], OpenForCustomer: () => [new Opened()] },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.aggregateName).toBe("Account");
    });

    it("a command whose target is wider than the id is a type error", () => {
      class Account extends Domain.Aggregate("Account", {
        id: AccountId,
        state: Schema.Struct({}),
        initial: {},
        // @ts-expect-error OpenAny's target must be this aggregate's id schema
        commands: [OpenAny],
        decide: { OpenAny: () => [new Opened()] },
        evolve: { Opened: (s) => s },
      }) {}
      expect(Account.aggregateName).toBe("Account");
    });
  });
});
