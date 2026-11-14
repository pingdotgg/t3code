import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Account } from "./Account.aggregate.ts";
import { mustOwn } from "./mustOwn.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

/** One movement of money on an account. */
export class StatementLine extends Domain.Event("StatementLine", {
  kind: Schema.Literals([
    "deposit",
    "withdrawal",
    "transfer-in",
    "transfer-out",
    "refund",
    "settlement",
  ]),
  amount: Cents,
  balance: Cents,
}) {}

const line =
  (kind: StatementLine["kind"]) =>
  (e: { readonly amount: number; readonly balanceAfter: number }) =>
    new StatementLine({ kind, amount: e.amount, balance: e.balanceAfter });

/**
 * Every movement of money on an account, oldest first: six events become
 * one. It keeps the account's owner so it can authorize reads.
 */
export class Statement extends Domain.View("Statement", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({ customerId: Schema.NullOr(CustomerId) }),
  initial: { customerId: null },
  evolve: {
    AccountOpened: (_, e) => ({ customerId: e.customerId }),
    OwnerChanged: (_, e) => ({ customerId: e.customerId }),
  },
  validate: Effect.fn(function* (_request, statement) {
    yield* mustOwn(statement?.customerId ?? null);
  }),
  events: [StatementLine],
  emit: {
    MoneyDeposited: line("deposit"),
    MoneyWithdrawn: line("withdrawal"),
    TransferCredited: line("transfer-in"),
    TransferDebited: line("transfer-out"),
    TransferRefunded: line("refund"),
    SettlementReceived: line("settlement"),
  },
}) {}
