import * as tpu from "@distilled.cloud/gcp/tpu_v2";
import * as Layer from "effect/Layer";
import { makeTpuQueuedResourceHttpBinding } from "./BindingHttp.ts";
import { GetQueuedResource } from "./GetQueuedResource.ts";

/**
 * HTTP implementation of {@link GetQueuedResource}.
 *
 * @layer
 * @provides GCP.TPU.GetQueuedResource
 */
export const GetQueuedResourceHttp = Layer.effect(
  GetQueuedResource,
  makeTpuQueuedResourceHttpBinding({
    tag: "GCP.TPU.GetQueuedResource",
    iam: { role: "roles/tpu.viewer" },
    operation: tpu.getProjectsLocationsQueuedResources,
  }),
);
