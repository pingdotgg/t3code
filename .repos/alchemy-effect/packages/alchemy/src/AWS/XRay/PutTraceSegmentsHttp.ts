import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { PutTraceSegments } from "./PutTraceSegments.ts";

/**
 * HTTP implementation of the `XRay.PutTraceSegments` binding.
 *
 * At deploy time it grants `xray:PutTraceSegments` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const putTraceSegments = yield* XRay.PutTraceSegments();
 *   // ...
 * }).pipe(Effect.provide(XRay.PutTraceSegmentsHttp));
 * ```
 */
export const PutTraceSegmentsHttp = Layer.effect(
  PutTraceSegments,
  makeXRayHttpBinding({
    tag: "AWS.XRay.PutTraceSegments",
    operation: xray.putTraceSegments,
    actions: ["xray:PutTraceSegments"],
  }),
);
