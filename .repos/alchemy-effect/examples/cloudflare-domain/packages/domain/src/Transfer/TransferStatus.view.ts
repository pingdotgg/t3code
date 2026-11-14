import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.aggregate.ts";
import { AccountId } from "../Account/Account.id.ts";
import { NotOwner } from "../Account/NotOwner.rejection.ts";
import { Actor } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { Transfer } from "./Transfer.aggregate.ts";

/**
 * The progress of one transfer, assembled from the Transfer and both
 * accounts. Each handler sets its own fact, so arrival order does not matter.
 * Its requester (or an agent) may read it; a recipient sees the transfer in
 * `AccountTransfers`.
 */
export class TransferStatus extends Domain.View("TransferStatus", {
  from: [Transfer, Account],
  key: Transfer,
  middleware: [Session],
  rejects: [NotOwner],
  keyOf: {
    TransferDebited: ({ event }) => Transfer.ref(event.transferId),
    TransferCredited: ({ event }) => Transfer.ref(event.transferId),
    TransferRefunded: ({ event }) => Transfer.ref(event.transferId),
  },
  state: Schema.Struct({
    from: Schema.NullOr(AccountId),
    to: Schema.NullOr(AccountId),
    amount: Schema.NullOr(Cents),
    requestedBy: Schema.NullOr(Actor),
    awaitingApproval: Schema.Boolean,
    debited: Schema.Boolean,
    credited: Schema.Boolean,
    refunded: Schema.Boolean,
    completedAt: Schema.NullOr(Schema.DateTimeUtc),
    failedReason: Schema.NullOr(Schema.String),
  }),
  initial: {
    from: null,
    to: null,
    amount: null,
    requestedBy: null,
    awaitingApproval: false,
    debited: false,
    credited: false,
    refunded: false,
    completedAt: null,
    failedReason: null,
  },
  evolve: {
    TransferRequested: (v, e) => ({
      ...v,
      from: e.from,
      to: e.to,
      amount: e.amount,
      requestedBy: e.requestedBy,
      awaitingApproval: e.needsApproval,
    }),
    TransferApproved: (v) => ({ ...v, awaitingApproval: false }),
    TransferDebited: (v) => ({ ...v, debited: true }),
    TransferCredited: (v) => ({ ...v, credited: true }),
    TransferRefunded: (v) => ({ ...v, refunded: true }),
    TransferCompleted: (v, _, { at }) => ({ ...v, completedAt: at }),
    TransferFailed: (v, e) => ({ ...v, awaitingApproval: false, failedReason: e.reason }),
  },
  validate: Effect.fn(function* (_request, status) {
    const actor = yield* CurrentActor;
    // Nothing to protect until the transfer is projected; agents may read any.
    if (actor._tag === "Agent" || status === null || status.requestedBy === null) return;
    const requester = status.requestedBy;
    if (
      actor._tag !== "Customer" ||
      requester._tag !== "Customer" ||
      requester.customerId !== actor.customerId
    ) {
      return yield* new NotOwner();
    }
  }),
  computed: {
    status: (v): "completed" | "failed" | "in-flight" | "awaiting-approval" | "pending" =>
      v.completedAt
        ? "completed"
        : v.failedReason
          ? "failed"
          : v.debited
            ? "in-flight"
            : v.awaitingApproval
              ? "awaiting-approval"
              : "pending",
  },
}) {}
