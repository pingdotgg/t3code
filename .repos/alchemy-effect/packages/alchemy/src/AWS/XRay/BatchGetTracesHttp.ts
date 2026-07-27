import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { BatchGetTraces } from "./BatchGetTraces.ts";
import { makeXRayHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of the `XRay.BatchGetTraces` binding.
 *
 * At deploy time it grants `xray:BatchGetTraces` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const batchGetTraces = yield* XRay.BatchGetTraces();
 *   // ...
 * }).pipe(Effect.provide(XRay.BatchGetTracesHttp));
 * ```
 */
export const BatchGetTracesHttp = Layer.effect(
  BatchGetTraces,
  makeXRayHttpBinding({
    tag: "AWS.XRay.BatchGetTraces",
    operation: xray.batchGetTraces,
    actions: ["xray:BatchGetTraces"],
  }),
);
