import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:ListSteps` — lists the bound cluster's steps, newest first (optionally filtered by state or id). Page with `Marker`.
 * @binding
 * @section Running Steps
 * @example List Running Steps
 * ```typescript
 * const listSteps = yield* AWS.EMR.ListSteps(cluster);
 *
 * const { Steps } = yield* listSteps({ StepStates: ["RUNNING"] });
 * ```
 */
export interface ListSteps extends Binding.Service<
  ListSteps,
  "AWS.EMR.ListSteps",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListStepsInput, "ClusterId">,
    ) => Effect.Effect<SVC.ListStepsOutput, SVC.ListStepsError>
  >
> {}
export const ListSteps = Binding.Service<ListSteps>("AWS.EMR.ListSteps");
