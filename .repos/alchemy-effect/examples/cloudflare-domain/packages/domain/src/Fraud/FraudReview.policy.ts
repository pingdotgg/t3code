import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { Account } from "../Account/Account.aggregate.ts";
import { FreezeAccount } from "../Account/FreezeAccount.command.ts";
import { system } from "../Actor.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { DailyOutflow, DailyOutflowExceeded } from "./DailyOutflow.view.ts";
import { FraudCheck } from "./FraudCheck.external.ts";

/** Whenever an account's daily outflow crosses the threshold, score it and freeze the account if risky. */
export class FraudReview extends Domain.Policy("FraudReview", {
  from: DailyOutflow,
  on: [DailyOutflowExceeded],
}) {}

export const FraudReviewLive = FraudReview.toLayer(
  Effect.gen(function* () {
    const fraud = yield* FraudCheck;
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event }) {
      const { risk } = yield* fraud.score({ accountId: source.id, amount: event.total });
      if (risk > 0.8) {
        // No session here: the policy acts as the system, in place of FreezeAccount's middleware.
        yield* accounts.send(source, new FreezeAccount({ reason: `fraud risk ${risk}` })).pipe(
          Effect.provideService(CurrentActor, system("FraudReview")),
          Effect.catchTag("NotOpen", () => Effect.void),
          Effect.catchTag("NotOwner", () => Effect.void),
        );
      }
    });
  }),
);
