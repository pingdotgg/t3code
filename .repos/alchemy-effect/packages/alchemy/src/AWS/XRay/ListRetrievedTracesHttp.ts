import * as xray from "@distilled.cloud/aws/xray";
import * as Layer from "effect/Layer";
import { makeXRayHttpBinding } from "./BindingHttp.ts";
import { ListRetrievedTraces } from "./ListRetrievedTraces.ts";

/**
 * HTTP implementation of the `XRay.ListRetrievedTraces` binding.
 *
 * At deploy time it grants `xray:ListRetrievedTraces` on `*` to the host Lambda
 * Function (the action does not support resource-level permissions); at
 * runtime it calls the X-Ray API with the function's execution role
 * credentials.
 *
 * @example Provide on the Function effect
 * ```typescript
 * import * as XRay from "alchemy/AWS/XRay";
 *
 * Effect.gen(function* () {
 *   const listRetrievedTraces = yield* XRay.ListRetrievedTraces();
 *   // ...
 * }).pipe(Effect.provide(XRay.ListRetrievedTracesHttp));
 * ```
 */
export const ListRetrievedTracesHttp = Layer.effect(
  ListRetrievedTraces,
  makeXRayHttpBinding({
    tag: "AWS.XRay.ListRetrievedTraces",
    operation: xray.listRetrievedTraces,
    actions: ["xray:ListRetrievedTraces"],
  }),
);
