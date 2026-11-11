import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/Account.id.ts";
import { Actor } from "../Actor.ts";
import { MfaChallenge } from "../MfaChallenge.middleware.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { TransferId } from "./Transfer.id.ts";

/** Transfers of at least this many cents wait for a support agent's approval. */
export const APPROVAL_THRESHOLD = 10_000;

export class AlreadyRequested extends Domain.Rejection("AlreadyRequested") {}

export class SameAccount extends Domain.Rejection("SameAccount") {}

export class TransferRequested extends Domain.Event("TransferRequested", {
  transferId: TransferId,
  from: AccountId,
  to: AccountId,
  amount: Cents,
  requestedBy: Actor,
  /** At or above {@link APPROVAL_THRESHOLD}: execution waits for `ApproveTransfer`. */
  needsApproval: Schema.Boolean,
}) {}

/**
 * Ask to move money between two accounts; `TransferExecution` carries it out
 * on behalf of the requester, after a support agent approves it if it is
 * large. The client picks the transfer id, so a retry is idempotent.
 */
export class RequestTransfer extends Domain.Command("RequestTransfer", {
  target: TransferId,
  middleware: [Session, MfaChallenge],
  input: { from: AccountId, to: AccountId, amount: Cents },
  events: [TransferRequested],
  rejects: [AlreadyRequested, SameAccount],
}) {}
