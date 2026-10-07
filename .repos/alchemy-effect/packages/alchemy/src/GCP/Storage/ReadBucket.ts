import type * as storage from "@distilled.cloud/gcp/storage_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { ObjectContent, ObjectRequestFailed } from "./ObjectMedia.ts";

export interface ListBucketOptions {
  /** Only objects whose name starts with this prefix. */
  prefix?: string;
  /** Group names by this delimiter (e.g. `/`) into `prefixes`. */
  delimiter?: string;
  /** Maximum objects per page. */
  maxResults?: number;
  /** Page token from a previous `list`. */
  pageToken?: string;
}

export interface ListBucketResult {
  objects: storage.Storage_Object[];
  /** Common prefixes when `delimiter` is set. */
  prefixes: string[];
  /** Pass to the next `list` call; `undefined` on the last page. */
  nextPageToken: string | undefined;
}

/** Read-only client for one Cloud Storage bucket. */
export interface ReadBucketClient {
  /** Object metadata, or `undefined` when the object does not exist. */
  head(
    object: string,
  ): Effect.Effect<
    storage.Storage_Object | undefined,
    storage.GetObjectsError,
    RuntimeContext
  >;
  /** Object content, or `undefined` when the object does not exist. */
  get(
    object: string,
    options?: { generation?: string },
  ): Effect.Effect<
    ObjectContent | undefined,
    ObjectRequestFailed,
    RuntimeContext
  >;
  /** One page of object listings. */
  list(
    options?: ListBucketOptions,
  ): Effect.Effect<ListBucketResult, storage.ListObjectsError, RuntimeContext>;
}

/**
 * Read access to a Cloud Storage {@link Bucket}: `head`, `get`, `list`.
 * Grants `roles/storage.objectViewer` on the bucket only.
 *
 * ### Reading a bucket
 * **Example:** Read an object and list a prefix
 * ```typescript
 * const uploads = yield* GCP.Storage.ReadBucket(bucket);
 * const object = yield* uploads.get("hello.txt");
 * const text = object && new TextDecoder().decode(object.body);
 * const { objects } = yield* uploads.list({ prefix: "images/" });
 * // …provided with Effect.provide(GCP.Storage.ReadBucketHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReadBucket extends Binding.Service<
  ReadBucket,
  "GCP.Storage.ReadBucket",
  (bucket: Bucket) => Effect.Effect<ReadBucketClient>
> {}

export const ReadBucket = Binding.Service<ReadBucket>("GCP.Storage.ReadBucket");
