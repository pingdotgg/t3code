import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ClaimUsername, UsernameClaimed, UsernameTaken } from "./ClaimUsername.command.ts";
import { CustomerId } from "./Customer.id.ts";
import { Username } from "./Username.ts";

/**
 * One username, and who holds it. Uniqueness spans every customer, so the
 * invariant is its own aggregate, keyed by the username: two customers
 * claiming the same name race on this one instance, and one of them wins.
 */
export class UsernameClaim extends Domain.Aggregate("UsernameClaim", {
  id: Username,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Claimed", { customerId: CustomerId }),
  ]),
  initial: { _tag: "Free" },
  commands: [ClaimUsername],
  decide: {
    ClaimUsername: (s, cmd) =>
      s._tag === "Free"
        ? [new UsernameClaimed({ customerId: cmd.customerId })]
        : s.customerId === cmd.customerId
          ? []
          : new UsernameTaken(),
  },
  evolve: {
    UsernameClaimed: (_, e) => ({ _tag: "Claimed" as const, customerId: e.customerId }),
  },
}) {}
