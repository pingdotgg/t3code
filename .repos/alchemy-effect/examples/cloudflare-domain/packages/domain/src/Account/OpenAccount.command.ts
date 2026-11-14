import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "../Customer/Customer.id.ts";
import { AccountId } from "./Account.id.ts";

export class AlreadyOpen extends Domain.Rejection("AlreadyOpen") {}

export class AccountOpened extends Domain.Event("AccountOpened", {
  customerId: CustomerId,
  owner: Schema.String,
}) {}

/** Open an account for a customer. Sent by `MainAccountProvisioning`. */
export class OpenAccount extends Domain.Command("OpenAccount", {
  target: AccountId,
  input: { customerId: CustomerId, owner: Schema.String },
  events: [AccountOpened],
  rejects: [AlreadyOpen],
}) {}
