import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetSamplingStatisticSummaries } from "./GetSamplingStatisticSummaries.ts";

/**
 * HTTP implementation of the `XRay.GetSamplingStatisticSummaries` binding.
 *
 * At deploy time it grants `xray:GetSamplingStatisticSummaries` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getSamplingStatisticSummaries = yield* XRay.GetSamplingStatisticSummaries();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetSamplingStatisticSummariesHttp));
 * ```
 */
export const GetSamplingStatisticSummariesHttp = Layer.effect(
  GetSamplingStatisticSummaries,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetSamplingStatisticSummaries",
    operation: xray.getSamplingStatisticSummaries,
    actions: ["xray:GetSamplingStatisticSummaries"],
  }),
);
