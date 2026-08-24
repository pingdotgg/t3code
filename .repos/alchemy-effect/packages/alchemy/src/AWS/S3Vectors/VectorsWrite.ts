import type * as s3vectors from "@distilled.cloud/aws/s3vectors";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./VectorIndex.ts";

/** Fields the binding injects from the bound {@link Index}. */
type IndexRef = "vectorBucketName" | "indexName" | "indexArn";

export interface PutVectorsRequest extends Omit<
  s3vectors.PutVectorsInput,
  IndexRef
> {}
export interface DeleteVectorsRequest extends Omit<
  s3vectors.DeleteVectorsInput,
  IndexRef
> {}

/**
 * The write-only runtime client returned by binding an {@link Index} via
 * {@link VectorsWrite}. All calls target the bound index (its ARN is
 * injected); pass raw distilled request shapes minus the index identifier.
 */
export interface WriteVectorsClient {
  /** Insert or overwrite vectors (keyed by `key`). */
  readonly put: (
    request: PutVectorsRequest,
  ) => Effect.Effect<s3vectors.PutVectorsOutput, s3vectors.PutVectorsError>;
  /** Delete vectors by key. */
  readonly delete: (
    request: DeleteVectorsRequest,
  ) => Effect.Effect<
    s3vectors.DeleteVectorsOutput,
    s3vectors.DeleteVectorsError
  >;
}

/**
 * Write-only runtime binding for the S3 Vectors data plane — insert and
 * delete vectors in a bound {@link Index}.
 *
 * Grants only `s3vectors:PutVectors` and `s3vectors:DeleteVectors` on
 * exactly the bound index's ARN — the least-privilege choice for ingestion
 * pipelines that write embeddings but never query them. Provide the
 * implementation with `Effect.provide(AWS.S3Vectors.VectorsWriteHttp)`.
 *
 * @binding
 * @section Writing Vectors
 * @example Insert Embeddings (write-only)
 * ```typescript
 * // init
 * const vectors = yield* AWS.S3Vectors.VectorsWrite(index);
 *
 * // runtime
 * yield* vectors.put({
 *   vectors: [{ key: "doc-1", data: { float32: [0.1, 0.2, 0.3] } }],
 * });
 * ```
 */
export interface VectorsWrite extends Binding.Service<
  VectorsWrite,
  "AWS.S3Vectors.VectorsWrite",
  <I extends Index>(index: I) => Effect.Effect<WriteVectorsClient>
> {}
export const VectorsWrite = Binding.Service<VectorsWrite>(
  "AWS.S3Vectors.VectorsWrite",
);
