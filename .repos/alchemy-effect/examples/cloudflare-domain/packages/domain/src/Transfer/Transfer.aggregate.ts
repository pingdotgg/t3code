import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/Account.id.ts";
import { NotPermitted } from "../Account/ChangeOwner.command.ts";
import { Actor } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Cents } from "../Money.ts";
import {
  ApproveTransfer,
  NotAwaitingApproval,
  TransferApproved,
} from "./ApproveTransfer.command.ts";
import { CompleteTransfer, TransferCompleted } from "./CompleteTransfer.command.ts";
import { ExpireTransfer } from "./ExpireTransfer.command.ts";
import { FailTransfer, TransferFailed } from "./FailTransfer.command.ts";
import {
  AlreadyRequested,
  APPROVAL_THRESHOLD,
  RequestTransfer,
  SameAccount,
  TransferRequested,
} from "./RequestTransfer.command.ts";
import { TransferId } from "./Transfer.id.ts";

const Details = { from: AccountId, to: AccountId, amount: Cents, requestedBy: Actor };

/**
 * A transfer between two accounts: the state of the TransferExecution
 * process. Large transfers wait for approval until their window closes;
 * approval and expiry race on this single instance, so one of them wins.
 */
export class Transfer extends Domain.Aggregate("Transfer", {
  id: TransferId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("AwaitingApproval", Details),
    Schema.TaggedStruct("Pending", Details),
    Schema.TaggedStruct("Completed", {}),
    Schema.TaggedStruct("Failed", { reason: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [RequestTransfer, ApproveTransfer, ExpireTransfer, CompleteTransfer, FailTransfer],
  decide: {
    // Records who asked, so TransferExecution debits the source on their behalf.
    RequestTransfer: Effect.fn(function* (s, cmd, { id }) {
      if (s._tag !== "New") return yield* new AlreadyRequested();
      if (cmd.from === cmd.to) return yield* new SameAccount();
      const requestedBy = yield* CurrentActor;
      return [
        new TransferRequested({
          transferId: id,
          from: cmd.from,
          to: cmd.to,
          amount: cmd.amount,
          requestedBy,
          needsApproval: cmd.amount >= APPROVAL_THRESHOLD,
        }),
      ];
    }),
    ApproveTransfer: Effect.fn(function* (s, _, { id }) {
      const approvedBy = yield* CurrentActor;
      if (approvedBy._tag !== "Agent") return yield* new NotPermitted();
      if (s._tag !== "AwaitingApproval") return yield* new NotAwaitingApproval();
      return [
        new TransferApproved({
          transferId: id,
          from: s.from,
          to: s.to,
          amount: s.amount,
          requestedBy: s.requestedBy,
          approvedBy,
        }),
      ];
    }),
    ExpireTransfer: (s, _, { id }) =>
      s._tag === "AwaitingApproval"
        ? [new TransferFailed({ transferId: id, reason: "not approved in time" })]
        : [],
    CompleteTransfer: (s, _, { id }) =>
      s._tag === "Pending" ? [new TransferCompleted({ transferId: id })] : [],
    FailTransfer: (s, cmd, { id }) =>
      s._tag === "Pending" ? [new TransferFailed({ transferId: id, reason: cmd.reason })] : [],
  },
  evolve: {
    TransferRequested: (_, e) => ({
      _tag: e.needsApproval ? ("AwaitingApproval" as const) : ("Pending" as const),
      from: e.from,
      to: e.to,
      amount: e.amount,
      requestedBy: e.requestedBy,
    }),
    TransferApproved: (_, e) => ({
      _tag: "Pending" as const,
      from: e.from,
      to: e.to,
      amount: e.amount,
      requestedBy: e.requestedBy,
    }),
    TransferCompleted: () => ({ _tag: "Completed" as const }),
    TransferFailed: (_, e) => ({ _tag: "Failed" as const, reason: e.reason }),
  },
}) {}
