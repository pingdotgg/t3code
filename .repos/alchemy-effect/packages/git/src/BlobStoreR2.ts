import * as Cloudflare from "@alchemy.run/cloudflare";
import type { R2Error, ReadWriteBucketClient } from "@alchemy.run/cloudflare/R2/index";
import type { RuntimeContext } from "alchemy/RuntimeContext";
/**
 * `Git.BlobStoreR2` — Cloudflare R2 implementation of {@link BlobStore}
 * (the default), over the `Cloudflare.R2.ReadWriteBucket` capability.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  BlobStore,
  BlobStoreError,
  orderedParts,
  type BlobBody,
  type BlobMeta,
  type BlobMultipart,
  type BlobStoreShape,
} from "./BlobStore.ts";

const r2Error = (what: string) => (error: R2Error) =>
  new BlobStoreError({ reason: `${what}: ${error.message}` });

/**
 * Builds the R2-backed shape from an already-resolved bucket client.
 * Used directly by the Repo DO (which resolves its own binding) and by
 * the {@link BlobStoreR2} layer.
 */
export const makeBlobStoreR2 = (bucket: ReadWriteBucketClient): BlobStoreShape => ({
  get: (key, range) =>
    bucket.get(key, range === undefined ? undefined : { range }).pipe(
      Effect.mapError(r2Error(`get ${key}`)),
      Effect.map((object) =>
        object === null
          ? null
          : ({
              size: object.size,
              bytes: object.bytes().pipe(Effect.mapError(r2Error(`read ${key}`))),
              stream: object.body.pipe(Stream.mapError(r2Error(`stream ${key}`))),
              readable: object.readable,
            } satisfies BlobBody),
      ),
    ),
  put: (key, body, options) => {
    // A stream body's own BlobStoreError joins R2's error union — map
    // only the R2 side, pass ours through.
    const write: Effect.Effect<unknown, R2Error | BlobStoreError, RuntimeContext> =
      body instanceof Uint8Array
        ? bucket.put(key, body)
        : bucket.put(key, body, {
            contentLength: options?.contentLength ?? 0,
          });
    return write.pipe(
      Effect.mapError((error) =>
        error instanceof BlobStoreError ? error : r2Error(`put ${key}`)(error),
      ),
      Effect.asVoid,
    );
  },
  head: (key) =>
    bucket.head(key).pipe(
      Effect.mapError(r2Error(`head ${key}`)),
      Effect.map((object) => (object === null ? null : { key, size: object.size })),
    ),
  multipart: (key) =>
    bucket.createMultipartUpload(key).pipe(
      Effect.mapError(r2Error(`multipart ${key}`)),
      Effect.map((upload): BlobMultipart => ({
        uploadId: upload.uploadId,
        uploadPart: (partNumber, part) =>
          upload
            .uploadPart(partNumber, part)
            .pipe(Effect.mapError(r2Error(`part ${partNumber} of ${key}`))),
        complete: (parts) =>
          upload
            .complete(orderedParts(parts))
            .pipe(Effect.mapError(r2Error(`complete ${key}`)), Effect.asVoid),
        abort: upload.abort().pipe(Effect.mapError(r2Error(`abort ${key}`)), Effect.asVoid),
      })),
    ),
  uploadPart: (key, uploadId, partNumber, part) =>
    bucket.resumeMultipartUpload(key, uploadId).pipe(
      Effect.flatMap((upload) => upload.uploadPart(partNumber, part)),
      Effect.mapError(r2Error(`part ${partNumber} of ${key}`)),
    ),
  delete: (keys) =>
    bucket
      .delete(typeof keys === "string" ? keys : [...keys])
      .pipe(Effect.mapError(r2Error("delete")), Effect.asVoid),
  list: (prefix) =>
    Stream.paginate(undefined as string | undefined, (cursor) =>
      bucket.list({ prefix, limit: 1000, cursor }).pipe(
        Effect.mapError(r2Error(`list ${prefix}`)),
        Effect.map((page) => {
          const metas = page.objects.map((object): BlobMeta => ({
            key: object.key,
            size: object.size,
          }));
          return [
            metas,
            page.truncated ? Option.some(page.cursor) : Option.none<string>(),
          ] as const;
        }),
      ),
    ),
});

/**
 * R2-backed {@link BlobStore}: packs, bundles, oversize objects, and
 * push spill live in the given bucket. Requires the
 * `Cloudflare.R2.ReadWriteBucket` capability; provide an implementation
 * (`Cloudflare.R2.ReadWriteBucketBinding` or `ReadWriteBucketHttp`) on the
 * Worker.
 *
 * @layer
 * @provides Git.BlobStore
 */
export const BlobStoreR2 = (
  bucket: Parameters<typeof Cloudflare.R2.ReadWriteBucket>[0],
): Layer.Layer<BlobStore, never, Cloudflare.R2.ReadWriteBucket> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- declaration-Effect requirement is resolved at stack eval, see comment at the cast below
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const client = yield* Cloudflare.R2.ReadWriteBucket(bucket);
      return makeBlobStoreR2(client);
    }),
    // `bucket` may be a declaration Effect, which widens the inferred requirement.
  ) as Layer.Layer<BlobStore, never, Cloudflare.R2.ReadWriteBucket>;
