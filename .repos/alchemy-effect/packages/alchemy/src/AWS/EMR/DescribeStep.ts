import type * as SVC from "@distilled.cloud/aws/emr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:DescribeStep` — reads one step of the bound cluster — status, config, and failure details.
 * @binding
 * @section Running Steps
 * @example Poll a Step's State
 * ```typescript
 * const describeStep = yield* AWS.EMR.DescribeStep(cluster);
 *
 * const { Step } = yield* describeStep({ StepId: stepId });
 * // Step.Status.State: PENDING | RUNNING | COMPLETED | FAILED | …
 * ```
 */
export interface DescribeStep extends Binding.Service<
  DescribeStep,
  "AWS.EMR.DescribeStep",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DescribeStepInput, "ClusterId">,
    ) => Effect.Effect<SVC.DescribeStepOutput, SVC.DescribeStepError>
  >
> {}
export const DescribeStep = Binding.Service<DescribeStep>(
  "AWS.EMR.DescribeStep",
);
