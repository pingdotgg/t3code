import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Account } from "../Account/Account.aggregate.ts";
import { SettlementOnClosedAccount } from "../Account/RecordSettlement.command.ts";
import { Payments } from "./Payments.external.ts";

/** Whenever money settles on a closed account, refund it. */
export class SettlementRefund extends Domain.Policy("SettlementRefund", {
  from: Account,
  on: [SettlementOnClosedAccount],
}) {}

export const SettlementRefundLive = SettlementRefund.toLayer(
  Effect.gen(function* () {
    const payments = yield* Payments;
    return Effect.fn(function* ({ event }) {
      yield* payments.refund({ settlementId: event.settlementId, amount: event.amount });
    });
  }),
);
