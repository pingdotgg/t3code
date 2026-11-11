import * as Domain from "@alchemy.run/domain";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

/** Someone else holds this username. */
export class UsernameTaken extends Domain.Rejection("UsernameTaken") {}

export class UsernameClaimed extends Domain.Event("UsernameClaimed", { customerId: CustomerId }) {}

/**
 * Reserve a username for a customer. Sent by `UsernameReservation`; claiming
 * a username the customer already holds records nothing.
 */
export class ClaimUsername extends Domain.Command("ClaimUsername", {
  target: Username,
  input: { customerId: CustomerId },
  events: [UsernameClaimed],
  rejects: [UsernameTaken],
}) {}
