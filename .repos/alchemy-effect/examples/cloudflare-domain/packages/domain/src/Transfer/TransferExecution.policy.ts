import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { TransferApproved } from "./ApproveTransfer.command.ts";
import { Decision, ExecuteTransfer } from "./ExecuteTransfer.saga.ts";
import { TransferFailed } from "./FailTransfer.command.ts";
import { TransferRequested } from "./RequestTransfer.command.ts";
import { Transfer } from "./Transfer.aggregate.ts";

/**
 * Starts the ExecuteTransfer saga for every requested transfer, and passes on
 * what the Transfer decides about a large one: approved, or expired.
 */
export class TransferExecution extends Domain.Policy("TransferExecution", {
  from: Transfer,
  on: [TransferRequested, TransferApproved, TransferFailed],
}) {}

export const TransferExecutionLive = TransferExecution.toLayer(
  Effect.gen(function* () {
    const executions = yield* ExecuteTransfer;
    return Effect.fn(function* ({ source, event }) {
      switch (event._tag) {
        case "TransferRequested":
          yield* executions.start(source, {
            from: event.from,
            to: event.to,
            amount: event.amount,
            requestedBy: event.requestedBy,
            needsApproval: event.needsApproval,
          });
          return;
        case "TransferApproved":
          return yield* executions.get(source).signal(Decision, "approved");
        case "TransferFailed":
          // A transfer that expired waiting for approval; a saga that already
          // finished ignores it.
          return yield* executions.get(source).signal(Decision, "expired");
      }
    });
  }),
);
