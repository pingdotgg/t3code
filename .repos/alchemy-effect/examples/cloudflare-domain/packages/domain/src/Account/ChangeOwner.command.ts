import * as Domain from "@alchemy.run/domain";
import { Actor } from "../Actor.ts";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";

/** Only support agents may reassign accounts. */
export class NotPermitted extends Domain.Rejection("NotPermitted") {}

export class OwnerChanged extends Domain.Event("OwnerChanged", {
  previous: CustomerId,
  customerId: CustomerId,
  by: Actor,
}) {}

/** Reassign an account to another customer. */
export class ChangeOwner extends Domain.Command("ChangeOwner", {
  target: AccountId,
  middleware: [Session],
  input: { customerId: CustomerId },
  events: [OwnerChanged],
  rejects: [NotOpen, NotPermitted],
}) {}
