import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { GetTimeSeriesServiceStatistics } from "./GetTimeSeriesServiceStatistics.ts";

/**
 * HTTP implementation of the `XRay.GetTimeSeriesServiceStatistics` binding.
 *
 * At deploy time it grants `xray:GetTimeSeriesServiceStatistics` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const getTimeSeriesServiceStatistics = yield* XRay.GetTimeSeriesServiceStatistics();
 *   // ...
 * }).pipe(Effect.provide(XRay.GetTimeSeriesServiceStatisticsHttp));
 * ```
 */
export const GetTimeSeriesServiceStatisticsHttp = Layer.effect(
  GetTimeSeriesServiceStatistics,
  makeXRayHttpBinding({
    tag: "AWS.XRay.GetTimeSeriesServiceStatistics",
    operation: xray.getTimeSeriesServiceStatistics,
    actions: ["xray:GetTimeSeriesServiceStatistics"],
  }),
);
