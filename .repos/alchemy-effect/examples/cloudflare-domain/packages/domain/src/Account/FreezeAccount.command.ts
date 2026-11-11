import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Actor } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

export class AccountFrozen extends Domain.Event("AccountFrozen", {
  reason: Schema.String,
  by: Actor,
}) {}

/** Stop money leaving an account. Freezing a frozen account records nothing. */
export class FreezeAccount extends Domain.Command("FreezeAccount", {
  target: AccountId,
  middleware: [Session],
  input: { reason: Schema.String },
  events: [AccountFrozen],
  rejects: [NotOpen, NotOwner],
}) {}
