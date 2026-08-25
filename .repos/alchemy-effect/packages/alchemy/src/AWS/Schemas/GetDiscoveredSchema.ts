import type * as schemas from "@distilled.cloud/aws/schemas";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `schemas:GetDiscoveredSchema`.
 *
 * Infers an OpenAPI 3 or JSONSchema Draft 4 schema from up to 10 sample
 * events — the same inference the schema discoverer applies to live traffic,
 * exposed as an on-demand call. The operation is account-level (it is not
 * scoped to any registry or schema). Provide the implementation with
 * `Effect.provide(AWS.Schemas.GetDiscoveredSchemaHttp)`.
 * @binding
 * @section Discovering Schemas
 * @example Infer A Schema From Sample Events
 * ```typescript
 * // init — account-level, no resource to bind
 * const getDiscoveredSchema = yield* AWS.Schemas.GetDiscoveredSchema();
 *
 * // runtime — events are full AWS event envelopes as JSON strings
 * const { Content } = yield* getDiscoveredSchema({
 *   Type: "OpenApi3",
 *   Events: [JSON.stringify(sampleEvent)],
 * });
 * ```
 */
export interface GetDiscoveredSchema extends Binding.Service<
  GetDiscoveredSchema,
  "AWS.Schemas.GetDiscoveredSchema",
  () => Effect.Effect<
    (request?: {
      /** Up to 10 sample events (full AWS event envelopes) as JSON strings. */
      Events?: string[];
      /** The type of schema to infer: `OpenApi3` or `JSONSchemaDraft4`. */
      Type?: string;
    }) => Effect.Effect<
      schemas.GetDiscoveredSchemaResponse,
      schemas.GetDiscoveredSchemaError
    >
  >
> {}
export const GetDiscoveredSchema = Binding.Service<GetDiscoveredSchema>(
  "AWS.Schemas.GetDiscoveredSchema",
);
