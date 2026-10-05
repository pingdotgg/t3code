import type * as documentai from "@distilled.cloud/gcp/documentai_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { SchemasSchemaVersion } from "./SchemasSchemaVersion.ts";

export interface GetSchemaVersionRequest extends Omit<
  documentai.GetProjectsLocationsSchemasSchemaVersionsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `schemaVersions.get`.
 *
 * Bind this operation to a {@link SchemasSchemaVersion} in a
 * Function/Action init phase. Provide {@link GetSchemaVersionHttp}.
 *
 * ### Reading a Schema Version
 * **Example:** Read the bound schema version
 * ```typescript
 * const getVersion = yield* GCP.DocumentAI.GetSchemaVersion(version);
 * const live = yield* getVersion();
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface GetSchemaVersion extends Binding.Service<
  GetSchemaVersion,
  "GCP.DocumentAI.GetSchemaVersion",
  (
    version: SchemasSchemaVersion,
  ) => Effect.Effect<
    (
      request?: GetSchemaVersionRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1SchemaVersion,
      documentai.GetProjectsLocationsSchemasSchemaVersionsError,
      RuntimeContext
    >
  >
> {}

export const GetSchemaVersion = Binding.Service<GetSchemaVersion>(
  "GCP.DocumentAI.GetSchemaVersion",
);
