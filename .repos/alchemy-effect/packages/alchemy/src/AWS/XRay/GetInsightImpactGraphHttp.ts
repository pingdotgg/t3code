import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetInsightImpactGraph } from "./GetInsightImpactGraph.ts";

/**
 * HTTP implementation of the `XRay.GetInsightImpactGraph` binding.
 *
 * At deploy time it grants `xray:GetInsightImpactGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightImpactGraph = yield* XRay.GetInsightImpactGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightImpactGraphHttp));
 * ```
 */
export const GetInsightImpactGraphHttp = Layer.effect(
  GetInsightImpactGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightImpactGraph",
    operation: xray.getInsightImpactGraph,
    actions: ["xray:GetInsightImpactGraph"],
  }),
);
