import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Forbidden } from "../Forbidden.rejection.ts";
import { Session } from "../Session.middleware.ts";
import { Account } from "./Account.aggregate.ts";
import { OwnerChanged } from "./ChangeOwner.command.ts";
import { AccountClosed } from "./CloseAccount.command.ts";
import { AccountFrozen } from "./FreezeAccount.command.ts";
import { SettlementOnClosedAccount } from "./RecordSettlement.command.ts";
import { RefundStranded } from "./RefundTransfer.command.ts";

/** Operational events for support tooling, passed through unchanged. Agents only. */
export class AccountActivity extends Domain.View("AccountActivity", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [Forbidden],
  validate: Effect.fn(function* (request) {
    const actor = yield* CurrentActor;
    if (actor._tag !== "Agent") {
      return yield* new Forbidden({ reason: `${request.mode} of account activity is for agents` });
    }
  }),
  events: [AccountFrozen, AccountClosed, OwnerChanged, RefundStranded, SettlementOnClosedAccount],
}) {}
