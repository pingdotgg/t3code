import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetSamplingRules } from "./GetSamplingRules.ts";

/**
 * HTTP implementation of the `XRay.GetSamplingRules` binding.
 *
 * At deploy time it grants `xray:GetSamplingRules` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingRules = yield* XRay.GetSamplingRules();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingRulesHttp));
 * ```
 */
export const GetSamplingRulesHttp = Layer.effect(
  GetSamplingRules,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingRules",
    operation: xray.getSamplingRules,
    actions: ["xray:GetSamplingRules"],
  }),
);
