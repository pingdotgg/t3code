import * as Domain from "@alchemy.run/domain";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/Transfer.id.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";

export class TransferCredited extends Domain.Event("TransferCredited", {
  transferId: TransferId,
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Pay a transfer's amount into the destination account. */
export class CreditTransfer extends Domain.Command("CreditTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents },
  events: [TransferCredited],
  rejects: [NotOpen],
}) {}
