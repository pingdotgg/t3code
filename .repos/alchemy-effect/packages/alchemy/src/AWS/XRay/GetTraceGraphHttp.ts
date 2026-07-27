import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetTraceGraph } from "./GetTraceGraph.ts";

/**
 * HTTP implementation of the `XRay.GetTraceGraph` binding.
 *
 * At deploy time it grants `xray:GetTraceGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getTraceGraph = yield* XRay.GetTraceGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTraceGraphHttp));
 * ```
 */
export const GetTraceGraphHttp = Layer.effect(
  GetTraceGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTraceGraph",
    operation: xray.getTraceGraph,
    actions: ["xray:GetTraceGraph"],
  }),
);
