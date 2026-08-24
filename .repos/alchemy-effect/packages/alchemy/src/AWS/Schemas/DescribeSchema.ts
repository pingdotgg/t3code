import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:DescribeSchema`.
 *
 * Reads the bound {@link Schema}'s document — the content, type, version,
 * and description — so a function can fetch the authoritative event contract
 * at runtime (e.g. to validate incoming payloads against the registered
 * schema). The registry and schema names are injected from the binding; pass
 * `SchemaVersion` to read a specific version instead of the latest. Provide
 * the implementation with `Effect.provide(AWS.Schemas.DescribeSchemaHttp)`.
 * @binding
 * @section Reading Schemas
 * @example Fetch The Latest Schema Document
 * ```typescript
 * // init — bind the operation to the schema
 * const describeSchema = yield* AWS.Schemas.DescribeSchema(schema);
 *
 * // runtime
 * const { Content, SchemaVersion } = yield* describeSchema();
 * const document = JSON.parse(Content!);
 * ```
 */
export interface DescribeSchema extends Binding.Service<
  DescribeSchema,
  "AWS.Schemas.DescribeSchema",
  (schema: Schema) => Effect.Effect<
    (request?: {
      /** The version of the schema to read. Defaults to the latest. */
      SchemaVersion?: string;
    }) => Effect.Effect<
      schemas.DescribeSchemaResponse,
      schemas.DescribeSchemaError
    >
  >
> {}
export const DescribeSchema = Binding.Service<DescribeSchema>(
  "AWS.Schemas.DescribeSchema",
);
