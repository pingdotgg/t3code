import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StopInstance } from "./StopInstance.ts";

/**
 * HTTP implementation of {@link StopInstance}.
 *
 * Grants `roles/compute.instanceAdmin.v1` on the bound instance only,
 * because no narrower predefined role contains `compute.instances.stop`.
 *
 * @layer
 * @provides GCP.Compute.StopInstance
 */
export const StopInstanceHttp = Layer.effect(
  StopInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.StopInstance",
    iam: { role: "roles/compute.instanceAdmin.v1", on: "compute.instance" },
    operation: compute.stopInstances,
  }),
);
