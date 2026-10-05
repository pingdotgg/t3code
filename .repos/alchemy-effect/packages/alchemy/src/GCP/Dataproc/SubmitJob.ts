import type * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";

export interface SubmitJobRequest extends Omit<
  dataproc.SubmitProjectsRegionsJobsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Dataproc `jobs.submit`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Action init
 * phase. Provide {@link SubmitJobHttp}. The bound cluster is injected as
 * `job.placement.clusterName` unless the request already sets one.
 *
 * ### Submitting Jobs
 * **Example:** Run SparkPi on the bound cluster
 * ```typescript
 * const submitJob = yield* GCP.Dataproc.SubmitJob(cluster);
 * const job = yield* submitJob({
 *   body: {
 *     job: {
 *       sparkJob: {
 *         mainClass: "org.apache.spark.examples.SparkPi",
 *         jarFileUris: [
 *           "file:///usr/lib/spark/examples/jars/spark-examples.jar",
 *         ],
 *         args: ["10"],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category Dataproc
 */
export interface SubmitJob extends Binding.Service<
  SubmitJob,
  "GCP.Dataproc.SubmitJob",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: SubmitJobRequest,
    ) => Effect.Effect<
      dataproc.Job,
      dataproc.SubmitProjectsRegionsJobsError,
      RuntimeContext
    >
  >
> {}

export const SubmitJob = Binding.Service<SubmitJob>("GCP.Dataproc.SubmitJob");
