import type * as composer from "@distilled.cloud/gcp/composer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { EnvironmentsUserWorkloadsConfigMap } from "./EnvironmentsUserWorkloadsConfigMap.ts";

export interface GetUserWorkloadsConfigMapRequest extends Omit<
  composer.GetProjectsLocationsEnvironmentsUserWorkloadsConfigMapsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Composer `userWorkloadsConfigMaps.get`.
 *
 * Bind this operation to an {@link EnvironmentsUserWorkloadsConfigMap}
 * in a Function/Action init phase. Provide
 * {@link GetUserWorkloadsConfigMapHttp}.
 *
 * ### Observing ConfigMaps
 * **Example:** Read the bound ConfigMap
 * ```typescript
 * const getConfigMap = yield* GCP.Composer.GetUserWorkloadsConfigMap(
 *   config,
 * );
 * const live = yield* getConfigMap();
 * ```
 *
 * @binding
 * @category Composer
 */
export interface GetUserWorkloadsConfigMap extends Binding.Service<
  GetUserWorkloadsConfigMap,
  "GCP.Composer.GetUserWorkloadsConfigMap",
  (
    configMap: EnvironmentsUserWorkloadsConfigMap,
  ) => Effect.Effect<
    (
      request?: GetUserWorkloadsConfigMapRequest,
    ) => Effect.Effect<
      composer.UserWorkloadsConfigMap,
      composer.GetProjectsLocationsEnvironmentsUserWorkloadsConfigMapsError,
      RuntimeContext
    >
  >
> {}

export const GetUserWorkloadsConfigMap =
  Binding.Service<GetUserWorkloadsConfigMap>(
    "GCP.Composer.GetUserWorkloadsConfigMap",
  );
