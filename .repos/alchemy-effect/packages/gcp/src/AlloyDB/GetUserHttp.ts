import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Layer from "effect/Layer";
import { makeAlloyDbUserHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeAlloyDbUserHttpBinding({
    tag: "GCP.AlloyDB.GetUser",
    iam: { role: "roles/alloydb.viewer" },
    operation: alloydb.getProjectsLocationsClustersUsers,
  }),
);
