import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

export class CustomerRegistered extends Domain.Event("CustomerRegistered", {
  name: Schema.String,
  username: Username,
}) {}

/** The username was claimed. Reports an outcome, so it never rejects. */
export class ConfirmRegistration extends Domain.Command("ConfirmRegistration", {
  target: CustomerId,
  events: [CustomerRegistered],
}) {}
