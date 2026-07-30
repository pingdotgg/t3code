import type * as s3vectors from "@distilled.cloud/aws/s3vectors";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./VectorIndex.ts";

/** Fields the binding injects from the bound {@link Index}. */
type IndexRef = "vectorBucketName" | "indexName" | "indexArn";

export interface QueryVectorsRequest extends Omit<
  s3vectors.QueryVectorsInput,
  IndexRef
> {}
export interface GetVectorsRequest extends Omit<
  s3vectors.GetVectorsInput,
  IndexRef
> {}
export interface ListVectorsRequest extends Omit<
  s3vectors.ListVectorsInput,
  IndexRef
> {}

/**
 * The read-only runtime client returned by binding an {@link Index} via
 * {@link VectorsRead}. All calls target the bound index (its ARN is
 * injected); pass raw distilled request shapes minus the index identifier.
 */
export interface ReadVectorsClient {
  /** Nearest-neighbor similarity query. */
  readonly query: (
    request: QueryVectorsRequest,
  ) => Effect.Effect<s3vectors.QueryVectorsOutput, s3vectors.QueryVectorsError>;
  /** Fetch vectors by key. */
  readonly get: (
    request: GetVectorsRequest,
  ) => Effect.Effect<s3vectors.GetVectorsOutput, s3vectors.GetVectorsError>;
  /** List vectors (paginated / segmented scan). */
  readonly list: (
    request: ListVectorsRequest,
  ) => Effect.Effect<s3vectors.ListVectorsOutput, s3vectors.ListVectorsError>;
}

/**
 * Read-only runtime binding for the S3 Vectors data plane — query, get, and
 * list vectors in a bound {@link Index}.
 *
 * Grants only `s3vectors:QueryVectors`, `s3vectors:GetVectors`, and
 * `s3vectors:ListVectors` on exactly the bound index's ARN — the
 * least-privilege choice for retrieval-only consumers (e.g. a RAG search
 * endpoint that never writes embeddings). Provide the implementation with
 * `Effect.provide(AWS.S3Vectors.VectorsReadHttp)`.
 *
 * @binding
 * @section Reading Vectors
 * @example Query Nearest Neighbors (read-only)
 * ```typescript
 * // init
 * const vectors = yield* AWS.S3Vectors.VectorsRead(index);
 *
 * // runtime
 * const result = yield* vectors.query({
 *   topK: 5,
 *   queryVector: { float32: [0.1, 0.2, 0.3] },
 *   returnDistance: true,
 * });
 * ```
 */
export interface VectorsRead extends Binding.Service<
  VectorsRead,
  "AWS.S3Vectors.VectorsRead",
  <I extends Index>(index: I) => Effect.Effect<ReadVectorsClient>
> {}
export const VectorsRead = Binding.Service<VectorsRead>(
  "AWS.S3Vectors.VectorsRead",
);
