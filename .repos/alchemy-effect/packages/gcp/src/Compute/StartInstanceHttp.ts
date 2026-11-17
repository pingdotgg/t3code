import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StartInstance } from "./StartInstance.ts";

/**
 * HTTP implementation of {@link StartInstance}.
 *
 * Grants `roles/compute.instanceAdmin.v1` on the bound instance only,
 * because no narrower predefined role contains `compute.instances.start`.
 *
 * @layer
 * @provides GCP.Compute.StartInstance
 */
export const StartInstanceHttp = Layer.effect(
  StartInstance,
  makeInstanceHttpBinding({
    tag: "GCP.Compute.StartInstance",
    iam: { role: "roles/compute.instanceAdmin.v1", on: "compute.instance" },
    operation: compute.startInstances,
  }),
);
