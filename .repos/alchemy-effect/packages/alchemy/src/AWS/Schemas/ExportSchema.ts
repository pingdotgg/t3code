import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:ExportSchema`.
 *
 * Exports the bound {@link Schema} as a JSONSchema Draft 4 document —
 * useful when a function needs a portable validation schema for an event
 * contract that is registered as OpenAPI 3. The registry and schema names
 * are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Schemas.ExportSchemaHttp)`.
 *
 * Note: AWS only allows exporting discovered or AWS-managed schemas
 * (registries `discovered-schemas` / `aws.events`). Calling it on a
 * custom-registry schema fails with a typed `ForbiddenException`
 * (`You cannot export non discovered or non aws managed schemas.`).
 * @binding
 * @section Reading Schemas
 * @example Export As JSONSchema Draft 4
 * ```typescript
 * // init — bind the operation to the schema
 * const exportSchema = yield* AWS.Schemas.ExportSchema(schema);
 *
 * // runtime
 * const { Content } = yield* exportSchema({ Type: "JSONSchemaDraft4" });
 * const jsonSchema = JSON.parse(Content!);
 * ```
 */
export interface ExportSchema extends Binding.Service<
  ExportSchema,
  "AWS.Schemas.ExportSchema",
  (schema: Schema) => Effect.Effect<
    (request?: {
      /** The version of the schema to export. Defaults to the latest. */
      SchemaVersion?: string;
      /**
       * The target format. `JSONSchemaDraft4` is the only supported value.
       * @default "JSONSchemaDraft4"
       */
      Type?: string;
    }) => Effect.Effect<schemas.ExportSchemaResponse, schemas.ExportSchemaError>
  >
> {}
export const ExportSchema = Binding.Service<ExportSchema>(
  "AWS.Schemas.ExportSchema",
);
