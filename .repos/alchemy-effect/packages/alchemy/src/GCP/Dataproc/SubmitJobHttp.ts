import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Cluster } from "./Cluster.ts";
import { SubmitJob, type SubmitJobRequest } from "./SubmitJob.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link SubmitJob}.
 *
 * Grants `roles/dataproc.editor` on the project because
 * `dataproc.jobs.create` is checked on the project (jobs are not children
 * of the cluster, so neither a cluster-level grant nor an IAM Condition on
 * the cluster name applies) and no narrower predefined role contains it.
 *
 * @layer
 * @provides GCP.Dataproc.SubmitJob
 */
export const SubmitJobHttp = Layer.effect(
  SubmitJob,
  Effect.gen(function* () {
    const submitProjectsRegionsJobs = yield* dataproc.submitProjectsRegionsJobs;
    return Effect.fn(function* <T extends Cluster>(cluster: T) {
      yield* bindGcpHost({
        tag: "GCP.Dataproc.SubmitJob",
        resource: cluster,
        // dataproc.jobs.create is checked on the project (jobs are not
        // children of the cluster); no narrower predefined role contains it.
        iam: [{ role: "roles/dataproc.editor" }],
      });
      const projectId = yield* cluster.project;
      const region = yield* cluster.region;
      const clusterName = yield* cluster.clusterName;
      return Effect.fn(`GCP.Dataproc.SubmitJob(${cluster.LogicalId})`)(
        function* (request: SubmitJobRequest) {
          const resolvedProject = yield* projectId;
          const resolvedRegion = yield* region;
          const resolvedCluster = yield* clusterName;
          const job = request.body?.job;
          return yield* submitProjectsRegionsJobs({
            ...request,
            projectId: resolvedProject,
            region: resolvedRegion,
            body: {
              ...request?.body,
              job: {
                ...job,
                placement: {
                  ...job?.placement,
                  clusterName: job?.placement?.clusterName ?? resolvedCluster,
                },
              },
            },
          });
        },
      );
    });
  }),
);
