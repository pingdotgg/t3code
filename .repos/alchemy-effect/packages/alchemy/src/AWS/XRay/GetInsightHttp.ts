import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetInsight } from "./GetInsight.ts";

/**
 * HTTP implementation of the `XRay.GetInsight` binding.
 *
 * At deploy time it grants `xray:GetInsight` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsight = yield* XRay.GetInsight();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightHttp));
 * ```
 */
export const GetInsightHttp = Layer.effect(
  GetInsight,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsight",
    operation: xray.getInsight,
    actions: ["xray:GetInsight"],
  }),
);
