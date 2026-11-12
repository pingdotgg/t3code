import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.aggregate.ts";
import { mustOwn } from "../Account/mustOwn.ts";
import { NotOwner } from "../Account/NotOwner.rejection.ts";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { type TransferRequested } from "./RequestTransfer.command.ts";
import { Transfer } from "./Transfer.aggregate.ts";
import { TransferId } from "./Transfer.id.ts";

/** Money moved in or out of an account by a transfer. */
export class TransferMoved extends Domain.Event("TransferMoved", {
  transferId: TransferId,
  amount: Cents,
  direction: Schema.Literals(["in", "out"]),
}) {}

const moved = (direction: "in" | "out") => (e: TransferRequested) =>
  new TransferMoved({ transferId: e.transferId, amount: e.amount, direction });

/**
 * Transfers touching an account. One request is routed to both accounts, so
 * the recipient sees incoming transfers here. It keeps the account's owner so
 * it can authorize reads.
 */
export class AccountTransfers extends Domain.View("AccountTransfers", {
  from: [Transfer, Account],
  key: Account,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({ customerId: Schema.NullOr(CustomerId) }),
  initial: { customerId: null },
  evolve: {
    AccountOpened: (_, e) => ({ customerId: e.customerId }),
    OwnerChanged: (_, e) => ({ customerId: e.customerId }),
  },
  validate: Effect.fn(function* (_request, transfers) {
    yield* mustOwn(transfers?.customerId ?? null);
  }),
  keyOf: {
    TransferRequested: {
      out: ({ event }) => Account.ref(event.from),
      in: ({ event }) => Account.ref(event.to),
    },
  },
  events: [TransferMoved],
  emit: {
    TransferRequested: { out: moved("out"), in: moved("in") },
  },
}) {}
