import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:DescribeServiceActionExecutionParameters`.
 *
 * Gets the parameters required to execute a self-service action on a provisioned product — call it before `ExecuteProvisionedProductServiceAction` to build the parameter form.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.DescribeServiceActionExecutionParametersHttp)`.
 * @binding
 * @section Service Actions
 * @example Read a Service Action's Parameters
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeServiceActionExecutionParameters = yield* AWS.ServiceCatalog.DescribeServiceActionExecutionParameters();
 *
 * // runtime
 * const { ServiceActionParameters } =
 *   yield* describeServiceActionExecutionParameters({
 *     ProvisionedProductId: "pp-abc123",
 *     ServiceActionId: "act-abc123",
 *   });
 * ```
 */
export interface DescribeServiceActionExecutionParameters extends Binding.Service<
  DescribeServiceActionExecutionParameters,
  "AWS.ServiceCatalog.DescribeServiceActionExecutionParameters",
  () => Effect.Effect<
    (
      request: servicecatalog.DescribeServiceActionExecutionParametersInput,
    ) => Effect.Effect<
      servicecatalog.DescribeServiceActionExecutionParametersOutput,
      servicecatalog.DescribeServiceActionExecutionParametersError
    >
  >
> {}
export const DescribeServiceActionExecutionParameters =
  Binding.Service<DescribeServiceActionExecutionParameters>(
    "AWS.ServiceCatalog.DescribeServiceActionExecutionParameters",
  );
