import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Layer from "effect/Layer";
import { makeAlloyDbInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeAlloyDbInstanceHttpBinding({
    tag: "GCP.AlloyDB.GetInstance",
    iam: { role: "roles/alloydb.viewer" },
    operation: alloydb.getProjectsLocationsClustersInstances,
  }),
);
