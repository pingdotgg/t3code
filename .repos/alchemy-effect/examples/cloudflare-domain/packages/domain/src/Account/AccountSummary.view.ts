import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Account } from "./Account.aggregate.ts";
import { mustOwn } from "./mustOwn.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

const setBalance = <V extends { balance: number }>(
  v: V,
  e: { readonly balanceAfter: number },
): V => ({
  ...v,
  balance: e.balanceAfter,
});

/**
 * The current balance and status of one account. It declares no events, so
 * it emits every event it applies, each with the summary after it.
 */
export class AccountSummary extends Domain.View("AccountSummary", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({
    customerId: Schema.NullOr(CustomerId),
    owner: Schema.NullOr(Schema.String),
    balance: Cents,
    frozen: Schema.Boolean,
    closed: Schema.Boolean,
  }),
  initial: { customerId: null, owner: null, balance: 0, frozen: false, closed: false },
  evolve: {
    AccountOpened: (v, e) => ({ ...v, customerId: e.customerId, owner: e.owner }),
    OwnerChanged: (v, e) => ({ ...v, customerId: e.customerId }),
    MoneyDeposited: setBalance,
    MoneyWithdrawn: setBalance,
    TransferDebited: setBalance,
    TransferCredited: setBalance,
    TransferRefunded: setBalance,
    SettlementReceived: setBalance,
    AccountFrozen: (v) => ({ ...v, frozen: true }),
    AccountClosed: (v) => ({ ...v, closed: true }),
  },
  // Re-run on every change while watched: a reassigned account ends the watch with NotOwner.
  validate: Effect.fn(function* (_request, summary) {
    yield* mustOwn(summary?.customerId ?? null);
  }),
}) {}
