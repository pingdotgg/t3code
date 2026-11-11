import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Compute.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.GetInstance",
    iam: { role: "roles/compute.viewer", on: "compute.instance" },
    operation: compute.getInstances,
  }),
);
