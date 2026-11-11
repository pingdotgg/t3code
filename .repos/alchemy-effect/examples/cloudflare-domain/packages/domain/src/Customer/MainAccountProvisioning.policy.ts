import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Account } from "../Account/Account.aggregate.ts";
import { mainAccountId } from "../Account/Account.id.ts";
import { OpenAccount } from "../Account/OpenAccount.command.ts";
import { CustomerRegistered } from "./ConfirmRegistration.command.ts";
import { Customer } from "./Customer.aggregate.ts";

/** Whenever a customer registers, open their main account. */
export class MainAccountProvisioning extends Domain.Policy("MainAccountProvisioning", {
  from: Customer,
  on: [CustomerRegistered],
}) {}

export const MainAccountProvisioningLive = MainAccountProvisioning.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event }) {
      yield* accounts
        .send(
          mainAccountId(source.id),
          new OpenAccount({ customerId: source.id, owner: event.name }),
        )
        .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));
    });
  }),
);
