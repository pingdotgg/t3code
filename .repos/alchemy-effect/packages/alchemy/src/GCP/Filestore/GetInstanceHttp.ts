import * as file from "@distilled.cloud/gcp/file_v1";
import * as Layer from "effect/Layer";
import { makeFilestoreInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Filestore.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeFilestoreInstanceHttpBinding({
    tag: "GCP.Filestore.GetInstance",
    iam: { role: "roles/file.viewer" },
    operation: file.getProjectsLocationsInstances,
  }),
);
