import type * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Collector } from "./Collector.ts";

export interface RegisterCollectorRequest extends Omit<
  rma.RegisterProjectsLocationsCollectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Rapid Migration Assessment `collectors.register`.
 *
 * Bind this operation to a {@link Collector} in a Function/Action init
 * phase. Provide {@link RegisterCollectorHttp}.
 *
 * Grants `roles/rma.runner` on the project: Rapid Migration Assessment
 * has no resource-level IAM.
 *
 * ### Registering Collectors
 * **Example:** Register the bound collector
 * ```typescript
 * const registerCollector =
 *   yield* GCP.RapidMigrationAssessment.RegisterCollector(onPrem);
 * yield* registerCollector();
 * ```
 *
 * @binding
 * @category RapidMigrationAssessment
 */
export interface RegisterCollector extends Binding.Service<
  RegisterCollector,
  "GCP.RapidMigrationAssessment.RegisterCollector",
  (
    collector: Collector,
  ) => Effect.Effect<
    (
      request?: RegisterCollectorRequest,
    ) => Effect.Effect<
      rma.Operation,
      rma.RegisterProjectsLocationsCollectorsError,
      RuntimeContext
    >
  >
> {}

export const RegisterCollector = Binding.Service<RegisterCollector>(
  "GCP.RapidMigrationAssessment.RegisterCollector",
);
