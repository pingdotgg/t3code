import * as Domain from "@alchemy.run/domain";
import { MfaChallenge } from "../MfaChallenge.middleware.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { Frozen } from "./Frozen.rejection.ts";
import { InsufficientFunds } from "./InsufficientFunds.rejection.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

/** Daily withdrawal limit, in cents. */
export const DAILY_LIMIT = 100_000;

export class DailyLimitExceeded extends Domain.Rejection("DailyLimitExceeded", {
  remaining: Cents,
}) {}

export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Take money out of an account, within the balance and the daily limit. */
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  target: AccountId,
  middleware: [Session, MfaChallenge],
  input: { amount: Cents },
  events: [MoneyWithdrawn],
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds, DailyLimitExceeded],
  reply: { balance: Cents },
  // Recorded on every span the withdrawal passes through; nothing else from it is.
  attributes: (cmd) => ({ "bank.amount": cmd.amount }),
}) {}
