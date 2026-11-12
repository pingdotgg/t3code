import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Account } from "../Account/Account.aggregate.ts";
import { TransferCredited } from "../Account/CreditTransfer.command.ts";
import { TransferDebited } from "../Account/DebitTransfer.command.ts";
import { MoneyDeposited } from "../Account/DepositMoney.command.ts";
import { SettlementReceived } from "../Account/RecordSettlement.command.ts";
import { TransferRefunded } from "../Account/RefundTransfer.command.ts";
import { MoneyWithdrawn } from "../Account/WithdrawMoney.command.ts";
import { LedgerStore } from "./LedgerStore.ts";

/** Every money movement, one row each, in a database outside the model. */
export class Ledger extends Domain.Projection("Ledger", {
  from: [Account],
  key: Account,
  on: [
    MoneyDeposited,
    MoneyWithdrawn,
    TransferDebited,
    TransferCredited,
    TransferRefunded,
    SettlementReceived,
  ],
}) {}

/** Writes each batch of an account's movements in one database round-trip. */
export const LedgerLive = Ledger.toLayer(
  Effect.gen(function* () {
    const store = yield* LedgerStore;
    return Effect.fn(function* (batch) {
      yield* store.record(
        batch.map(({ key, event, envelope }) => ({
          id: `${envelope.stream}:${envelope.seq}`,
          accountId: key.id,
          kind: event._tag,
          amount: event.amount,
          balanceAfter: event.balanceAfter,
          at: DateTime.toEpochMillis(envelope.at),
        })),
      );
    });
  }),
  { batch: { size: 100, wait: "1 second" } },
);
