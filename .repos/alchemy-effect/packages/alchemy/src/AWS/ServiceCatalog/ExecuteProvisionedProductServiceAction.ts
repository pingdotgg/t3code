import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ExecuteProvisionedProductServiceAction`.
 *
 * Executes a self-service action (e.g. restart, snapshot — an SSM-document-backed operation the administrator attached to the product) on a provisioned product.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.ExecuteProvisionedProductServiceActionHttp)`.
 * @binding
 * @section Service Actions
 * @example Execute a Self-Service Action
 * ```typescript
 * // init — account-level binding, no resource argument
 * const executeProvisionedProductServiceAction = yield* AWS.ServiceCatalog.ExecuteProvisionedProductServiceAction();
 *
 * // runtime
 * const { RecordDetail } =
 *   yield* executeProvisionedProductServiceAction({
 *     ProvisionedProductId: "pp-abc123",
 *     ServiceActionId: "act-abc123",
 *     ExecuteToken: crypto.randomUUID(),
 *   });
 * ```
 */
export interface ExecuteProvisionedProductServiceAction extends Binding.Service<
  ExecuteProvisionedProductServiceAction,
  "AWS.ServiceCatalog.ExecuteProvisionedProductServiceAction",
  () => Effect.Effect<
    (
      request: servicecatalog.ExecuteProvisionedProductServiceActionInput,
    ) => Effect.Effect<
      servicecatalog.ExecuteProvisionedProductServiceActionOutput,
      servicecatalog.ExecuteProvisionedProductServiceActionError
    >
  >
> {}
export const ExecuteProvisionedProductServiceAction =
  Binding.Service<ExecuteProvisionedProductServiceAction>(
    "AWS.ServiceCatalog.ExecuteProvisionedProductServiceAction",
  );
