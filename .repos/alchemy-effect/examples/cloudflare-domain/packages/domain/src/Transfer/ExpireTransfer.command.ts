import * as Domain from "@alchemy.run/domain";
import { TransferFailed } from "./FailTransfer.command.ts";
import { TransferId } from "./Transfer.id.ts";

/**
 * The approval window closed. Scheduled by `TransferApprovalDeadline`; it
 * reports a fact, so it never rejects, and it records nothing if the transfer
 * was approved in time.
 */
export class ExpireTransfer extends Domain.Command("ExpireTransfer", {
  target: TransferId,
  events: [TransferFailed],
}) {}
