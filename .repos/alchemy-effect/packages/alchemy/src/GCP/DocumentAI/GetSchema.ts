import type * as documentai from "@distilled.cloud/gcp/documentai_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Schema } from "./Schema.ts";

export interface GetSchemaRequest extends Omit<
  documentai.GetProjectsLocationsSchemasRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `schemas.get`.
 *
 * Bind this operation to a {@link Schema} in a Function/Action init
 * phase. Provide {@link GetSchemaHttp}.
 *
 * ### Reading a Schema
 * **Example:** Read the bound schema
 * ```typescript
 * const getSchema = yield* GCP.DocumentAI.GetSchema(schema);
 * const live = yield* getSchema();
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface GetSchema extends Binding.Service<
  GetSchema,
  "GCP.DocumentAI.GetSchema",
  (
    schema: Schema,
  ) => Effect.Effect<
    (
      request?: GetSchemaRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1NextSchema,
      documentai.GetProjectsLocationsSchemasError,
      RuntimeContext
    >
  >
> {}

export const GetSchema = Binding.Service<GetSchema>("GCP.DocumentAI.GetSchema");
