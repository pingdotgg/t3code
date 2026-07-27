import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { PutTelemetryRecords } from "./PutTelemetryRecords.ts";

/**
 * HTTP implementation of the `XRay.PutTelemetryRecords` binding.
 *
 * At deploy time it grants `xray:PutTelemetryRecords` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const putTelemetryRecords = yield* XRay.PutTelemetryRecords();
 *   // ...
 * }).pipe(Effect.provide(XRay.PutTelemetryRecordsHttp));
 * ```
 */
export const PutTelemetryRecordsHttp = Layer.effect(
  PutTelemetryRecords,
  makeXRayHttpBinding({
    tag: "AWS.XRay.PutTelemetryRecords",
    operation: xray.putTelemetryRecords,
    actions: ["xray:PutTelemetryRecords"],
  }),
);
