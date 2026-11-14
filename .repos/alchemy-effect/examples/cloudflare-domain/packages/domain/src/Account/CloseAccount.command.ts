import * as Domain from "@alchemy.run/domain";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

/** Only an empty account can be closed. */
export class BalanceNotZero extends Domain.Rejection("BalanceNotZero", { balance: Cents }) {}

export class AccountClosed extends Domain.Event("AccountClosed") {}

/** Close an empty account. */
export class CloseAccount extends Domain.Command("CloseAccount", {
  target: AccountId,
  middleware: [Session],
  events: [AccountClosed],
  rejects: [NotOpen, NotOwner, BalanceNotZero],
}) {}
