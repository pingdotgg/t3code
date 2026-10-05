import type * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ParametersVersion } from "./ParametersVersion.ts";

/**
 * Runtime binding for Parameter Manager `parameters.versions.render`.
 *
 * Bind this operation to a {@link ParametersVersion} in a Function/Action
 * init phase. Provide {@link RenderParameterVersionHttp}. Rendering
 * substitutes Secret Manager references and only works for JSON or YAML
 * parameters.
 *
 * Grants `roles/parametermanager.parameterAccessor` on the project under
 * an IAM Condition matching only this version: Parameter Manager has no
 * resource-level IAM. Secrets the payload references need their own
 * Secret Manager access.
 *
 * ### Rendering a Parameter Version
 * **Example:** Render JSON with secret substitutions
 * ```typescript
 * const render = yield* GCP.ParameterManager.RenderParameterVersion(version);
 * const { renderedPayload } = yield* render();
 * ```
 *
 * @binding
 * @category ParameterManager
 */
export interface RenderParameterVersion extends Binding.Service<
  RenderParameterVersion,
  "GCP.ParameterManager.RenderParameterVersion",
  (
    version: ParametersVersion,
  ) => Effect.Effect<
    () => Effect.Effect<
      parametermanager.RenderParameterVersionResponse,
      parametermanager.RenderProjectsLocationsParametersVersionsError,
      RuntimeContext
    >
  >
> {}

export const RenderParameterVersion = Binding.Service<RenderParameterVersion>(
  "GCP.ParameterManager.RenderParameterVersion",
);
