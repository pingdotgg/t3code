import type * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Parameter } from "./Parameter.ts";

/**
 * Runtime binding for Parameter Manager `parameters.get`.
 *
 * Bind this operation to a {@link Parameter} in a Function/Action init
 * phase. Provide {@link GetParameterHttp}.
 *
 * Grants `roles/parametermanager.parameterViewer` on the project under an
 * IAM Condition matching only this parameter: Parameter Manager has no
 * resource-level IAM.
 *
 * ### Reading a Parameter
 * **Example:** Get parameter metadata
 * ```typescript
 * const getParameter = yield* GCP.ParameterManager.GetParameter(parameter);
 * const live = yield* getParameter();
 * ```
 *
 * @binding
 * @category ParameterManager
 */
export interface GetParameter extends Binding.Service<
  GetParameter,
  "GCP.ParameterManager.GetParameter",
  (
    parameter: Parameter,
  ) => Effect.Effect<
    () => Effect.Effect<
      parametermanager.Parameter,
      parametermanager.GetProjectsLocationsParametersError,
      RuntimeContext
    >
  >
> {}

export const GetParameter = Binding.Service<GetParameter>(
  "GCP.ParameterManager.GetParameter",
);
