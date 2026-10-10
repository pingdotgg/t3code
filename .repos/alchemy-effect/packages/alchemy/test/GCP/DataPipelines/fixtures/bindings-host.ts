import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { serveProbes } from "../../bindingHost.ts";

/** Scratch bucket the Word Count template writes to. */
export const PipelineTmp = GCP.Storage.Bucket("PipelineBindTmp", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Batch pipeline the bindings run and stop (roles/datapipelines.invoker,
 * roles/datapipelines.admin on the project).
 */
export const BindBatch = Effect.gen(function* () {
  const bucket = yield* PipelineTmp;
  return yield* GCP.DataPipelines.Pipeline("BindBatch", {
    type: "PIPELINE_TYPE_BATCH",
    displayName: "bind-batch",
    workload: {
      dataflowLaunchTemplateRequest: {
        location: "us-central1",
        gcsPath: "gs://dataflow-templates/latest/Word_Count",
        launchParameters: {
          jobName: "alchemy-bind-word-count",
          parameters: {
            inputFile: "gs://dataflow-samples/shakespeare/kinglear.txt",
            output: Output.interpolate`gs://${bucket.bucketName}/out`,
          },
          environment: {
            tempLocation: Output.interpolate`gs://${bucket.bucketName}/tmp`,
          },
        },
      },
    },
  });
});

/**
 * Effect-native Cloud Run service exercising every Data Pipelines binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class DataPipelinesBindingsHost extends GCP.Function<DataPipelinesBindingsHost>()(
  "DataPipelinesBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const runPipeline = yield* GCP.DataPipelines.RunPipeline(BindBatch);
    const stopPipeline = yield* GCP.DataPipelines.StopPipeline(BindBatch);

    return {
      fetch: serveProbes({
        runPipeline: runPipeline(),
        // Stopping right after a run fails with `NotFound: Job not found.`
        // until Dataflow registers the launched job.
        stopPipeline: stopPipeline().pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            schedule: Schedule.spaced("3 seconds"),
            times: 20,
          }),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.DataPipelines.RunPipelineHttp),
    Effect.provide(GCP.DataPipelines.StopPipelineHttp),
  ),
) {}
