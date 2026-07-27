import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetRetrievedTracesGraph } from "./GetRetrievedTracesGraph.ts";

/**
 * HTTP implementation of the `XRay.GetRetrievedTracesGraph` binding.
 *
 * At deploy time it grants `xray:GetRetrievedTracesGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getRetrievedTracesGraph = yield* XRay.GetRetrievedTracesGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetRetrievedTracesGraphHttp));
 * ```
 */
export const GetRetrievedTracesGraphHttp = Layer.effect(
  GetRetrievedTracesGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetRetrievedTracesGraph",
    operation: xray.getRetrievedTracesGraph,
    actions: ["xray:GetRetrievedTracesGraph"],
  }),
);
