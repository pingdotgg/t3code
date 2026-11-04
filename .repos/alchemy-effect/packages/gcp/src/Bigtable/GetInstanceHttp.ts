import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Layer from "effect/Layer";
import { makeBigtableInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.Bigtable.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeBigtableInstanceHttpBinding({
    tag: "GCP.Bigtable.GetInstance",
    iam: { role: "roles/bigtable.viewer", on: "bigtable.instance" },
    operation: bigtable.getProjectsInstances,
  }),
);
