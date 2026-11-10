import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Layer from "effect/Layer";
import { makeAlloyDbConnectionInfoHttpBinding } from "./BindingHttp.ts";
import { GetConnectionInfo } from "./GetConnectionInfo.ts";

/**
 * HTTP implementation of {@link GetConnectionInfo}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetConnectionInfo
 */
export const GetConnectionInfoHttp = Layer.effect(
  GetConnectionInfo,
  makeAlloyDbConnectionInfoHttpBinding({
    tag: "GCP.AlloyDB.GetConnectionInfo",
    iam: { role: "roles/alloydb.client" },
    operation: alloydb.getConnectionInfoProjectsLocationsClustersInstances,
  }),
);
