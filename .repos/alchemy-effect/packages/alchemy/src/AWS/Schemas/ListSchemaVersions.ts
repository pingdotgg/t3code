import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Schema } from "./Schema.ts";

/**
 * Runtime binding for `schemas:ListSchemaVersions`.
 *
 * Lists the published versions of the bound {@link Schema} so a function can
 * enumerate the history of an event contract (e.g. to detect that a new
 * version was published, or to pin consumers to a version range). The
 * registry and schema names are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Schemas.ListSchemaVersionsHttp)`.
 * @binding
 * @section Reading Schemas
 * @example List All Versions
 * ```typescript
 * // init — bind the operation to the schema
 * const listSchemaVersions = yield* AWS.Schemas.ListSchemaVersions(schema);
 *
 * // runtime
 * const { SchemaVersions } = yield* listSchemaVersions();
 * const versions = (SchemaVersions ?? []).map((v) => v.SchemaVersion);
 * ```
 */
export interface ListSchemaVersions extends Binding.Service<
  ListSchemaVersions,
  "AWS.Schemas.ListSchemaVersions",
  (schema: Schema) => Effect.Effect<
    (request?: {
      /** The maximum number of versions to return per page. */
      Limit?: number;
      /** The pagination token from a previous response. */
      NextToken?: string;
    }) => Effect.Effect<
      schemas.ListSchemaVersionsResponse,
      schemas.ListSchemaVersionsError
    >
  >
> {}
export const ListSchemaVersions = Binding.Service<ListSchemaVersions>(
  "AWS.Schemas.ListSchemaVersions",
);
