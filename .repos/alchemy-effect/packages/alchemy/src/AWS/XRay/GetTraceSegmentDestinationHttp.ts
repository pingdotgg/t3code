import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetTraceSegmentDestination } from "./GetTraceSegmentDestination.ts";

/**
 * HTTP implementation of the `XRay.GetTraceSegmentDestination` binding.
 *
 * At deploy time it grants `xray:GetTraceSegmentDestination` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getTraceSegmentDestination = yield* XRay.GetTraceSegmentDestination();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTraceSegmentDestinationHttp));
 * ```
 */
export const GetTraceSegmentDestinationHttp = Layer.effect(
  GetTraceSegmentDestination,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTraceSegmentDestination",
    operation: xray.getTraceSegmentDestination,
    actions: ["xray:GetTraceSegmentDestination"],
  }),
);
