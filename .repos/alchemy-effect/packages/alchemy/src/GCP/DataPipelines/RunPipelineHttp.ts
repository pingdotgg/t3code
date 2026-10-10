import * as datapipelines from "@distilled.cloud/gcp/datapipelines_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makePipelineHttpBinding } from "./BindingHttp.ts";
import { RunPipeline } from "./RunPipeline.ts";

/**
 * HTTP implementation of {@link RunPipeline}.
 *
 * @layer
 * @provides GCP.DataPipelines.RunPipeline
 */
export const RunPipelineHttp: Layer.Layer<
  RunPipeline,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  RunPipeline,
  makePipelineHttpBinding<
    datapipelines.RunProjectsLocationsPipelinesRequest,
    datapipelines.GoogleCloudDatapipelinesV1RunPipelineResponse,
    datapipelines.RunProjectsLocationsPipelinesError
  >({
    tag: "GCP.DataPipelines.RunPipeline",
    iam: { role: "roles/datapipelines.invoker" },
    operation: datapipelines.runProjectsLocationsPipelines,
  }),
);
