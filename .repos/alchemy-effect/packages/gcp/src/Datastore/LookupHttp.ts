import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import * as Layer from "effect/Layer";
import { makeDatastoreHttpBinding } from "./BindingHttp.ts";
import { Lookup } from "./Lookup.ts";

/**
 * HTTP implementation of {@link Lookup}.
 *
 * @layer
 * @provides GCP.Datastore.Lookup
 */
export const LookupHttp = Layer.effect(
  Lookup,
  makeDatastoreHttpBinding({
    tag: "GCP.Datastore.Lookup",
    iam: { role: "roles/datastore.viewer", scopeByCondition: true },
    operation: datastore.lookupProjects,
  }),
);
