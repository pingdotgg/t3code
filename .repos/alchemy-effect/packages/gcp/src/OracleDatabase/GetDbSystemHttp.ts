import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetDbSystem } from "./GetDbSystem.ts";

/**
 * HTTP implementation of {@link GetDbSystem}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetDbSystem
 */
export const GetDbSystemHttp = Layer.effect(
  GetDbSystem,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetDbSystem",
    operation: oracle.getProjectsLocationsDbSystems,
    iam: { role: "roles/oracledatabase.dbSystemViewer" },
  }),
);
