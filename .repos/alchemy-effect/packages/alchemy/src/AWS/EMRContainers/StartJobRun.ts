import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:StartJobRun`.
 *
 * Submits a Spark job run to the bound {@link VirtualCluster}. The virtual
 * cluster ID is injected from the binding; pass a `jobDriver` +
 * `executionRoleArn` + `releaseLabel` directly, or a `jobTemplateId` (+
 * `jobTemplateParameters`) to start from a {@link JobTemplate}. Returns the
 * new job run's `id`/`arn` for use with `DescribeJobRun` / `CancelJobRun`.
 * Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.StartJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Start A Templated Spark Job
 * ```typescript
 * // init — bind the operation to the virtual cluster
 * const startJobRun = yield* AWS.EMRContainers.StartJobRun(virtualCluster);
 *
 * // runtime
 * const { id } = yield* startJobRun({
 *   jobTemplateId: templateId,
 *   jobTemplateParameters: { EntryPoint: "s3://my-bucket/etl.py" },
 * });
 * yield* Effect.log(`job run started: ${id}`);
 * ```
 */
export interface StartJobRun extends Binding.Service<
  StartJobRun,
  "AWS.EMRContainers.StartJobRun",
  (virtualCluster: VirtualCluster) => Effect.Effect<
    (
      request: Omit<
        emrc.StartJobRunRequest,
        "virtualClusterId" | "clientToken"
      > & {
        /**
         * Idempotency token for the job run submission.
         * @default auto-generated per call
         */
        clientToken?: string;
      },
    ) => Effect.Effect<emrc.StartJobRunResponse, emrc.StartJobRunError>
  >
> {}
export const StartJobRun = Binding.Service<StartJobRun>(
  "AWS.EMRContainers.StartJobRun",
);
