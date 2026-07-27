import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetInsightSummaries } from "./GetInsightSummaries.ts";

/**
 * HTTP implementation of the `XRay.GetInsightSummaries` binding.
 *
 * At deploy time it grants `xray:GetInsightSummaries` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getInsightSummaries = yield* XRay.GetInsightSummaries();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetInsightSummariesHttp));
 * ```
 */
export const GetInsightSummariesHttp = Layer.effect(
  GetInsightSummaries,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetInsightSummaries",
    operation: xray.getInsightSummaries,
    actions: ["xray:GetInsightSummaries"],
  }),
);
