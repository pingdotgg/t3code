import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Collection } from "./Collection.ts";

/**
 * Runtime binding for the `BatchGetCollection` operation scoped to one
 * collection (IAM action `aoss:BatchGetCollection` on the collection ARN).
 *
 * Reads the bound {@link Collection}'s live detail — status, endpoints, KMS
 * key — from inside a function runtime. Useful for discovering the data-plane
 * `collectionEndpoint` at runtime. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetCollectionHttp)`.
 * @binding
 * @section Inspecting Collections
 * @example Read the collection's endpoint and status
 * ```typescript
 * // init — bind the operation to the collection
 * const getCollection = yield* AWS.OpenSearchServerless.GetCollection(collection);
 *
 * // runtime
 * const detail = yield* getCollection();
 * yield* Effect.log(`${detail?.status}: ${detail?.collectionEndpoint}`);
 * ```
 */
export interface GetCollection extends Binding.Service<
  GetCollection,
  "AWS.OpenSearchServerless.GetCollection",
  (
    collection: Collection,
  ) => Effect.Effect<
    () => Effect.Effect<
      aoss.CollectionDetail | undefined,
      aoss.BatchGetCollectionError
    >
  >
> {}
export const GetCollection = Binding.Service<GetCollection>(
  "AWS.OpenSearchServerless.GetCollection",
);
