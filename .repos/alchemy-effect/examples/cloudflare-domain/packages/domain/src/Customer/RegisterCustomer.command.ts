import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Session } from "../Session.middleware.ts";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

/** The customer is registered, or a registration is already in progress. */
export class AlreadyRegistered extends Domain.Rejection("AlreadyRegistered") {}

/** A customer may only register themselves. */
export class NotTheCustomer extends Domain.Rejection("NotTheCustomer") {}

/** Registration waits for `UsernameReservation` to claim the username. */
export class RegistrationRequested extends Domain.Event("RegistrationRequested", {
  name: Schema.String,
  username: Username,
}) {}

/**
 * Sign up as a customer under a unique username. The customer is registered
 * once the username is claimed; `MainAccountProvisioning` then opens their
 * main account.
 */
export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  target: CustomerId,
  middleware: [Session],
  input: { name: Schema.String, username: Username },
  events: [RegistrationRequested],
  rejects: [AlreadyRegistered, NotTheCustomer],
}) {}
