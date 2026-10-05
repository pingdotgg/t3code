import type * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Collector } from "./Collector.ts";

export interface PauseCollectorRequest extends Omit<
  rma.PauseProjectsLocationsCollectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Rapid Migration Assessment `collectors.pause`.
 *
 * Bind this operation to a {@link Collector} in a Function/Action init
 * phase. Provide {@link PauseCollectorHttp}.
 *
 * Grants `roles/rma.runner` on the project: Rapid Migration Assessment
 * has no resource-level IAM.
 *
 * ### Pausing Collectors
 * **Example:** Pause the bound collector
 * ```typescript
 * const pauseCollector = yield* GCP.RapidMigrationAssessment.PauseCollector(
 *   onPrem,
 * );
 * yield* pauseCollector();
 * ```
 *
 * @binding
 * @category RapidMigrationAssessment
 */
export interface PauseCollector extends Binding.Service<
  PauseCollector,
  "GCP.RapidMigrationAssessment.PauseCollector",
  (
    collector: Collector,
  ) => Effect.Effect<
    (
      request?: PauseCollectorRequest,
    ) => Effect.Effect<
      rma.Operation,
      rma.PauseProjectsLocationsCollectorsError,
      RuntimeContext
    >
  >
> {}

export const PauseCollector = Binding.Service<PauseCollector>(
  "GCP.RapidMigrationAssessment.PauseCollector",
);
