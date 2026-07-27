import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { StartTraceRetrieval } from "./StartTraceRetrieval.ts";

/**
 * HTTP implementation of the `XRay.StartTraceRetrieval` binding.
 *
 * At deploy time it grants `xray:StartTraceRetrieval` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const startTraceRetrieval = yield* XRay.StartTraceRetrieval();
 *   // ...
 * }).pipe(Effect.provide(XRay.StartTraceRetrievalHttp));
 * ```
 */
export const StartTraceRetrievalHttp = Layer.effect(
  StartTraceRetrieval,
  makeXRayHttpBinding({
    tag: "AWS.XRay.StartTraceRetrieval",
    operation: xray.startTraceRetrieval,
    actions: ["xray:StartTraceRetrieval"],
  }),
);
