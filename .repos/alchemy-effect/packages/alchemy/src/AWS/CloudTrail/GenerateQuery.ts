import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Runtime binding for `cloudtrail:GenerateQuery`.
 *
 * Generates a CloudTrail Lake SQL statement from a natural-language prompt
 * against the bound {@link EventDataStore} (the store list is injected from
 * the binding). Provide the implementation with
 * `Effect.provide(AWS.CloudTrail.GenerateQueryHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example Generate SQL from a Prompt
 * ```typescript
 * // init — bind the operation to the event data store
 * const generateQuery = yield* AWS.CloudTrail.GenerateQuery(store);
 *
 * // runtime
 * const result = yield* generateQuery({
 *   Prompt: "What are my top errors in the past month?",
 * });
 * console.log(result.QueryStatement);
 * ```
 */
export interface GenerateQuery extends Binding.Service<
  GenerateQuery,
  "AWS.CloudTrail.GenerateQuery",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: Omit<cloudtrail.GenerateQueryRequest, "EventDataStores">,
    ) => Effect.Effect<
      cloudtrail.GenerateQueryResponse,
      cloudtrail.GenerateQueryError
    >
  >
> {}
export const GenerateQuery = Binding.Service<GenerateQuery>(
  "AWS.CloudTrail.GenerateQuery",
);
