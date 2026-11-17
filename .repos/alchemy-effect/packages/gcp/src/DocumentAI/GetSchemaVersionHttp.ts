import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeSchemaVersionHttpBinding } from "./BindingHttp.ts";
import { GetSchemaVersion } from "./GetSchemaVersion.ts";

/**
 * HTTP implementation of {@link GetSchemaVersion}.
 *
 * @layer
 * @provides GCP.DocumentAI.GetSchemaVersion
 */
export const GetSchemaVersionHttp = Layer.effect(
  GetSchemaVersion,
  makeSchemaVersionHttpBinding({
    tag: "GCP.DocumentAI.GetSchemaVersion",
    operation: documentai.getProjectsLocationsSchemasSchemaVersions,
    iam: { role: "roles/documentai.viewer" },
  }),
);
