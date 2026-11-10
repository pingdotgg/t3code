import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makePipelineHttpBinding } from "./BindingHttp.ts";
import { StopPipeline } from "./StopPipeline.ts";

/**
 * HTTP implementation of {@link StopPipeline}.
 *
 * @layer
 * @provides GCP.DataPipelines.StopPipeline
 */
export const StopPipelineHttp: Layer.Layer<
  StopPipeline,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  StopPipeline,
  makePipelineHttpBinding<
    datapipelines.StopProjectsLocationsPipelinesRequest,
    datapipelines.GoogleCloudDatapipelinesV1Pipeline,
    datapipelines.StopProjectsLocationsPipelinesError
  >({
    tag: "GCP.DataPipelines.StopPipeline",
    // No narrower predefined role contains datapipelines.pipelines.stop.
    iam: { role: "roles/datapipelines.admin" },
    operation: datapipelines.stopProjectsLocationsPipelines,
  }),
);
