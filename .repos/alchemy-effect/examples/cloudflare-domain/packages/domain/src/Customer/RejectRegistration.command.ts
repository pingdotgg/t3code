import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

/** The registration failed; the customer may register again. */
export class RegistrationRejected extends Domain.Event("RegistrationRejected", {
  username: Username,
  reason: Schema.String,
}) {}

/** The username could not be claimed. Reports an outcome, so it never rejects. */
export class RejectRegistration extends Domain.Command("RejectRegistration", {
  target: CustomerId,
  input: { reason: Schema.String },
  events: [RegistrationRejected],
}) {}
