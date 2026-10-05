import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { CAPACITY_REGION } from "../../zones.ts";

/**
 * Cluster the bindings target: GetCluster is granted on it
 * (roles/dataproc.viewer), SubmitJob on the project (roles/dataproc.editor).
 */
export const Jobs = GCP.Dataproc.Cluster("Jobs", {
  region: CAPACITY_REGION,
  // No zone: Dataproc Auto Zone Placement picks a zone in the region with
  // capacity, so a single-zone stockout cannot fail the deploy.
});

/**
 * Effect-native Cloud Run service exercising every Dataproc binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class DataprocBindingsHost extends GCP.Function<DataprocBindingsHost>()(
  "DataprocBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCluster = yield* GCP.Dataproc.GetCluster(Jobs);
    const submitJob = yield* GCP.Dataproc.SubmitJob(Jobs);

    return {
      fetch: serveProbes({
        getCluster: getCluster(),
        submitJob: submitJob({
          body: { job: { pigJob: { queryList: { queries: ["DUMP;"] } } } },
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Dataproc.GetClusterHttp),
    Effect.provide(GCP.Dataproc.SubmitJobHttp),
  ),
) {}
