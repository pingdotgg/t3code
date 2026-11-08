import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.context.ts";
import { ConfirmRegistration, CustomerRegistered } from "./ConfirmRegistration.command.ts";
import { CustomerId } from "./Customer.id.ts";
import {
  AlreadyRegistered,
  NotTheCustomer,
  RegisterCustomer,
  RegistrationRequested,
} from "./RegisterCustomer.command.ts";
import { RegistrationRejected, RejectRegistration } from "./RejectRegistration.command.ts";
import { Username } from "./Username.ts";

const Profile = { name: Schema.String, username: Username };

/**
 * A customer. Registration is a small saga: the request records the profile,
 * `UsernameReservation` claims the username, then the registration is
 * confirmed or rejected.
 */
export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Pending", Profile),
    Schema.TaggedStruct("Registered", Profile),
  ]),
  initial: { _tag: "New" },
  commands: [RegisterCustomer, ConfirmRegistration, RejectRegistration],
  decide: {
    RegisterCustomer: Effect.fn(function* (s, cmd, { id }) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== id) return yield* new NotTheCustomer();
      if (s._tag !== "New") return yield* new AlreadyRegistered();
      return [new RegistrationRequested({ name: cmd.name, username: cmd.username })];
    }),
    ConfirmRegistration: (s) =>
      s._tag === "Pending" ? [new CustomerRegistered({ name: s.name, username: s.username })] : [],
    RejectRegistration: (s, cmd) =>
      s._tag === "Pending"
        ? [new RegistrationRejected({ username: s.username, reason: cmd.reason })]
        : [],
  },
  evolve: {
    RegistrationRequested: (_, e) => ({
      _tag: "Pending" as const,
      name: e.name,
      username: e.username,
    }),
    CustomerRegistered: (_, e) => ({
      _tag: "Registered" as const,
      name: e.name,
      username: e.username,
    }),
    RegistrationRejected: () => ({ _tag: "New" as const }),
  },
}) {}
