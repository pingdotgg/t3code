import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:AddJobFlowSteps` — submits work (Spark jobs, Hive queries, custom JARs) to the bound cluster as steps. The cluster id is injected as `JobFlowId`.
 * @binding
 * @section Running Steps
 * @example Submit a Spark Step
 * ```typescript
 * const addSteps = yield* AWS.EMR.AddJobFlowSteps(cluster);
 *
 * const { StepIds } = yield* addSteps({
 *   Steps: [{
 *     Name: "spark-pi",
 *     ActionOnFailure: "CONTINUE",
 *     HadoopJarStep: {
 *       Jar: "command-runner.jar",
 *       Args: ["spark-example", "SparkPi", "10"],
 *     },
 *   }],
 * });
 * ```
 */
export interface AddJobFlowSteps extends Binding.Service<
  AddJobFlowSteps,
  "AWS.EMR.AddJobFlowSteps",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.AddJobFlowStepsInput, "JobFlowId">,
    ) => Effect.Effect<SVC.AddJobFlowStepsOutput, SVC.AddJobFlowStepsError>
  >
> {}
export const AddJobFlowSteps = Binding.Service<AddJobFlowSteps>(
  "AWS.EMR.AddJobFlowSteps",
);
