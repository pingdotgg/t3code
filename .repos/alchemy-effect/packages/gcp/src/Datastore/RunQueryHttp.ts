import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Layer from "effect/Layer";
import { makeDatastoreHttpBinding } from "./BindingHttp.ts";
import { RunQuery } from "./RunQuery.ts";

/**
 * HTTP implementation of {@link RunQuery}.
 *
 * @layer
 * @provides GCP.Datastore.RunQuery
 */
export const RunQueryHttp = Layer.effect(
  RunQuery,
  makeDatastoreHttpBinding({
    tag: "GCP.Datastore.RunQuery",
    iam: { role: "roles/datastore.viewer", scopeByCondition: true },
    operation: datastore.runQueryProjects,
  }),
);
