import * as Domain from "@alchemy.run/domain";
import { AccountId } from "../Account/Account.id.ts";
import { NotPermitted } from "../Account/ChangeOwner.command.ts";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { TransferId } from "./Transfer.id.ts";

/** The transfer is not waiting for approval: it never needed it, or it expired. */
export class NotAwaitingApproval extends Domain.Rejection("NotAwaitingApproval") {}

/** Carries the transfer so `TransferExecution` can carry it out. */
export class TransferApproved extends Domain.Event("TransferApproved", {
  transferId: TransferId,
  from: AccountId,
  to: AccountId,
  amount: Cents,
  requestedBy: Actor,
  approvedBy: Actor,
}) {}

/** A support agent approves a large transfer before its approval window closes. */
export class ApproveTransfer extends Domain.Command("ApproveTransfer", {
  target: TransferId,
  middleware: [Session],
  events: [TransferApproved],
  rejects: [NotAwaitingApproval, NotPermitted],
}) {}
