import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";

/** Minimal Lambda endpoint for the Subscription provider lifecycle test. */
export class SubscriptionTargetFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "SubscriptionTargetFunction",
) {}

export const SubscriptionTargetFunctionLive = SubscriptionTargetFunction.make(
  { main: import.meta.url },
  Effect.succeed({}),
);

export default SubscriptionTargetFunctionLive;
