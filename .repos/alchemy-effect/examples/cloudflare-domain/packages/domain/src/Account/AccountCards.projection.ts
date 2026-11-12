import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Account } from "./Account.aggregate.ts";
import { AccountCard, CardChanged } from "./AccountCard.stream.ts";
import { AccountSummary } from "./AccountSummary.view.ts";
import { TransferCredited } from "./CreditTransfer.command.ts";
import { TransferDebited } from "./DebitTransfer.command.ts";
import { MoneyDeposited } from "./DepositMoney.command.ts";
import { AccountFrozen } from "./FreezeAccount.command.ts";
import { SettlementReceived } from "./RecordSettlement.command.ts";
import { TransferRefunded } from "./RefundTransfer.command.ts";
import { MoneyWithdrawn } from "./WithdrawMoney.command.ts";

/**
 * Appends a new card whenever an account's summary changes: each input
 * arrives with the summary's state after it.
 */
export class AccountCards extends Domain.Projection("AccountCards", {
  from: [AccountSummary],
  key: Account,
  on: [
    MoneyDeposited,
    MoneyWithdrawn,
    TransferDebited,
    TransferCredited,
    TransferRefunded,
    SettlementReceived,
    AccountFrozen,
  ],
  writes: [AccountCard],
}) {}

export const AccountCardsLive = AccountCards.toLayer(
  Effect.gen(function* () {
    const cards = yield* AccountCard;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const summary = input.state;
        if (!summary?.customerId || !summary.owner) continue;
        yield* cards.append(
          input,
          new CardChanged({
            customerId: summary.customerId,
            owner: summary.owner,
            balance: summary.balance,
            frozen: summary.frozen,
          }),
        );
      }
    });
  }),
);
