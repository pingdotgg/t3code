import type * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DocumentSchema } from "./DocumentSchema.ts";

export interface GetDocumentSchemaRequest extends Omit<
  cw.GetProjectsLocationsDocumentSchemasRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI Warehouse `documentSchemas.get`.
 *
 * Bind this operation to a {@link DocumentSchema} in a Function/Action
 * init phase. Provide {@link GetDocumentSchemaHttp}.
 *
 * ### Reading Schemas
 * **Example:** Read the bound schema
 * ```typescript
 * const getSchema = yield* GCP.ContentWarehouse.GetDocumentSchema(schema);
 * const live = yield* getSchema();
 * ```
 *
 * @binding
 * @category ContentWarehouse
 */
export interface GetDocumentSchema extends Binding.Service<
  GetDocumentSchema,
  "GCP.ContentWarehouse.GetDocumentSchema",
  (
    schema: DocumentSchema,
  ) => Effect.Effect<
    (
      request?: GetDocumentSchemaRequest,
    ) => Effect.Effect<
      cw.GoogleCloudContentwarehouseV1DocumentSchema,
      cw.GetProjectsLocationsDocumentSchemasError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentSchema = Binding.Service<GetDocumentSchema>(
  "GCP.ContentWarehouse.GetDocumentSchema",
);
