import type * as ml from "@distilled.cloud/gcp/ml_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ModelsVersion } from "./ModelsVersion.ts";

export interface GetVersionRequest extends Omit<
  ml.GetProjectsModelsVersionsRequest,
  "name"
> {}

/**
 * Runtime binding for AI Platform (legacy ML Engine) `versions.get`.
 *
 * Bind this operation to a {@link ModelsVersion} in a Function/Action
 * init phase. Provide {@link GetVersionHttp}.
 *
 * ### Reading a Version
 * **Example:** Get the bound version
 * ```typescript
 * const getVersion = yield* GCP.ML.GetVersion(version);
 * const live = yield* getVersion();
 * ```
 *
 * @binding
 * @category ML
 */
export interface GetVersion extends Binding.Service<
  GetVersion,
  "GCP.ML.GetVersion",
  (
    version: ModelsVersion,
  ) => Effect.Effect<
    (
      request?: GetVersionRequest,
    ) => Effect.Effect<
      ml.GoogleCloudMlV1__Version,
      ml.GetProjectsModelsVersionsError,
      RuntimeContext
    >
  >
> {}

export const GetVersion = Binding.Service<GetVersion>("GCP.ML.GetVersion");
