import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetSamplingTargets } from "./GetSamplingTargets.ts";

/**
 * HTTP implementation of the `XRay.GetSamplingTargets` binding.
 *
 * At deploy time it grants `xray:GetSamplingTargets` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingTargets = yield* XRay.GetSamplingTargets();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingTargetsHttp));
 * ```
 */
export const GetSamplingTargetsHttp = Layer.effect(
  GetSamplingTargets,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingTargets",
    operation: xray.getSamplingTargets,
    actions: ["xray:GetSamplingTargets"],
  }),
);
