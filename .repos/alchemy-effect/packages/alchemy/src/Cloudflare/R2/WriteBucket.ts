import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  Conditional,
  R2Error,
  MultipartOptions,
  MultipartUpload,
  R2Object,
  PutOptions,
} from "./BucketTypes.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Cloudflare.R2.WriteBucket",
  (bucket: Bucket) => Effect.Effect<WriteBucketClient>
> {}

export const WriteBucket = Binding.Service<WriteBucket>(
  "Cloudflare.R2.WriteBucket",
);

export interface WriteBucketClient {
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options?: PutOptions & {
      onlyIf: Conditional | Headers;
      contentLength?: number;
    },
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: PutOptions,
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options: PutOptions & {
      contentLength: number;
    },
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  delete(keys: string | string[]): Effect.Effect<void, R2Error, RuntimeContext>;
  createMultipartUpload(
    key: string,
    options?: MultipartOptions,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
}
