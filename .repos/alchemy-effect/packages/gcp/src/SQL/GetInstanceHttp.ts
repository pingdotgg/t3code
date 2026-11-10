import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import * as Layer from "effect/Layer";
import { makeSqlInstanceHttpBinding } from "./BindingHttp.ts";
import { GetInstance } from "./GetInstance.ts";

/**
 * HTTP implementation of {@link GetInstance}.
 *
 * @layer
 * @provides GCP.SQL.GetInstance
 */
export const GetInstanceHttp = Layer.effect(
  GetInstance,
  makeSqlInstanceHttpBinding({
    tag: "GCP.SQL.GetInstance",
    iam: { role: "roles/cloudsql.viewer", scopeByCondition: true },
    operation: sqladmin.getInstances,
  }),
);
