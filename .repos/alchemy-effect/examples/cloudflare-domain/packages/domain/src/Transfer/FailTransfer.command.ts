import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { TransferId } from "./Transfer.id.ts";

export class TransferFailed extends Domain.Event("TransferFailed", {
  transferId: TransferId,
  reason: Schema.String,
}) {}

/** Reports an outcome, so it never rejects. */
export class FailTransfer extends Domain.Command("FailTransfer", {
  target: TransferId,
  input: { reason: Schema.String },
  events: [TransferFailed],
}) {}
