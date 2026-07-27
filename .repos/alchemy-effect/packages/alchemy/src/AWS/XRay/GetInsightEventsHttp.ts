import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetInsightEvents } from "./GetInsightEvents.ts";

/**
 * HTTP implementation of the `XRay.GetInsightEvents` binding.
 *
 * At deploy time it grants `xray:GetInsightEvents` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightEvents = yield* XRay.GetInsightEvents();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightEventsHttp));
 * ```
 */
export const GetInsightEventsHttp = Layer.effect(
  GetInsightEvents,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightEvents",
    operation: xray.getInsightEvents,
    actions: ["xray:GetInsightEvents"],
  }),
);
