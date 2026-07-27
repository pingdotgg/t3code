import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetServiceGraph } from "./GetServiceGraph.ts";

/**
 * HTTP implementation of the `XRay.GetServiceGraph` binding.
 *
 * At deploy time it grants `xray:GetServiceGraph` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getServiceGraph = yield* XRay.GetServiceGraph();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetServiceGraphHttp));
 * ```
 */
export const GetServiceGraphHttp = Layer.effect(
  GetServiceGraph,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetServiceGraph",
    operation: xray.getServiceGraph,
    actions: ["xray:GetServiceGraph"],
  }),
);
