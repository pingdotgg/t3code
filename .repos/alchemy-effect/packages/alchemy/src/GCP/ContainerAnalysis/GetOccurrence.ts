import type * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Occurrence } from "./Occurrence.ts";

export interface GetOccurrenceRequest extends Omit<
  containeranalysis.GetProjectsOccurrencesRequest,
  "name"
> {}

/**
 * Runtime binding for Container Analysis `occurrences.get`.
 *
 * Bind this operation to an {@link Occurrence} in a Function/Action
 * init phase. Provide {@link GetOccurrenceHttp}.
 *
 * ### Reading an Occurrence
 * **Example:** Get the bound occurrence
 * ```typescript
 * const getOccurrence = yield* GCP.ContainerAnalysis.GetOccurrence(
 *   occurrence,
 * );
 * const live = yield* getOccurrence();
 * ```
 *
 * @binding
 * @category ContainerAnalysis
 */
export interface GetOccurrence extends Binding.Service<
  GetOccurrence,
  "GCP.ContainerAnalysis.GetOccurrence",
  (
    occurrence: Occurrence,
  ) => Effect.Effect<
    (
      request?: GetOccurrenceRequest,
    ) => Effect.Effect<
      containeranalysis.Occurrence,
      containeranalysis.GetProjectsOccurrencesError,
      RuntimeContext
    >
  >
> {}

export const GetOccurrence = Binding.Service<GetOccurrence>(
  "GCP.ContainerAnalysis.GetOccurrence",
);
