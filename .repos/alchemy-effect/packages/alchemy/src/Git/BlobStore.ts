/**
 * `Git.BlobStore` — the swappable bulk-byte store (RFC "Git Building
 * Blocks" §3.1).
 *
 * Immutable, content-addressed bulk bytes: compacted packs, clone
 * bundles, oversize loose objects, and spilled push bodies. The contract
 * is everything the pack plane needs and nothing more — ranged reads,
 * whole-object writes with a known length, multipart writes of unknown
 * length, delete, and prefix listing (GC only, never on a serving path).
 *
 * Implementations shipped:
 *
 * - {@link BlobStoreR2} — Cloudflare R2 over the existing
 *   `ReadWriteBucket` capability (the default).
 *
 * Multipart rules are the R2/S3 intersection: uniform part sizes
 * (≥ 5 MiB) except the last part.
 *
 * ### Providing the store
 * **Example:** R2 (the default)
 * ```typescript
 * const GitLive = Git.ApiLive.pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Git.BlobStoreR2(MyBucket)),
 *   // ...
 * );
 * ```
 */
import * as Cloudflare from "../Cloudflare/index.ts";
import type { R2Error, ReadWriteBucketClient } from "../Cloudflare/R2/index.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** Failure of a {@link BlobStore} operation. */
export class BlobStoreError extends Data.TaggedError("BlobStoreError")<{
  readonly reason: string;
}> {}

/** A read blob: size plus the bytes as a one-shot buffer or a stream. */
export interface BlobBody {
  readonly size: number;
  readonly bytes: Effect.Effect<Uint8Array, BlobStoreError>;
  readonly stream: Stream.Stream<Uint8Array, BlobStoreError>;
  /**
   * The store's native body stream when it has one, for serving paths
   * that pipe bytes to the client with no per-chunk Effect work (DESIGN
   * §22). Consume either this or `stream`, never both.
   */
  readonly readable?: ReadableStream<Uint8Array> | undefined;
}

/** One uploaded part of a multipart write, as the store identifies it. */
export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/**
 * An in-flight multipart write. Parts must be uniform in size (≥ 5 MiB)
 * except the last — the R2/S3 intersection. Parts may be uploaded from
 * ANY isolate that knows the key and `uploadId` (`BlobStoreShape.uploadPart`
 * — the push pipeline's hasher isolates do, DESIGN §22.10); the creator
 * completes with the collected parts, in any order.
 */
export interface BlobMultipart {
  readonly uploadId: string;
  readonly uploadPart: (
    partNumber: number,
    part: Uint8Array,
  ) => Effect.Effect<UploadedPart, BlobStoreError>;
  readonly complete: (
    parts: ReadonlyArray<UploadedPart>,
  ) => Effect.Effect<void, BlobStoreError>;
  readonly abort: Effect.Effect<void, BlobStoreError>;
}

/** Sorts parts by number: stores validate the uniform-part rule against the list as given. */
export const orderedParts = (
  parts: ReadonlyArray<UploadedPart>,
): Array<UploadedPart> =>
  [...parts].sort((a, b) => a.partNumber - b.partNumber);

/** One listed blob (GC/purge walks). */
export interface BlobMeta {
  readonly key: string;
  readonly size: number;
}

/** The service shape — see the module doc for semantics. */
export interface BlobStoreShape {
  /** Ranged read; omit `range` for the whole object. `null` = missing. */
  readonly get: (
    key: string,
    range?: { readonly offset: number; readonly length: number },
  ) => Effect.Effect<BlobBody | null, BlobStoreError, RuntimeContext>;
  /** Whole-object write. `contentLength` is required for streams. */
  readonly put: (
    key: string,
    body: Uint8Array | Stream.Stream<Uint8Array, BlobStoreError>,
    options?: { readonly contentLength?: number | undefined },
  ) => Effect.Effect<void, BlobStoreError, RuntimeContext>;
  /** Existence/size check without reading the body. */
  readonly head: (
    key: string,
  ) => Effect.Effect<BlobMeta | null, BlobStoreError, RuntimeContext>;
  /** Begin a multipart write (spilled push bodies of unknown length). */
  readonly multipart: (
    key: string,
  ) => Effect.Effect<BlobMultipart, BlobStoreError, RuntimeContext>;
  /**
   * Uploads one part of a multipart write created elsewhere (by key and
   * `uploadId`) — the resume path the push pipeline's hasher isolates use.
   */
  readonly uploadPart: (
    key: string,
    uploadId: string,
    partNumber: number,
    part: Uint8Array,
  ) => Effect.Effect<UploadedPart, BlobStoreError, RuntimeContext>;
  readonly delete: (
    keys: string | ReadonlyArray<string>,
  ) => Effect.Effect<void, BlobStoreError, RuntimeContext>;
  /** Prefix listing — GC/purge only, never on a serving path. */
  readonly list: (
    prefix: string,
  ) => Stream.Stream<BlobMeta, BlobStoreError, RuntimeContext>;
}

/**
 * The swappable bulk-byte store of the git service.
 *
 * @binding
 */
export class BlobStore extends Context.Service<BlobStore, BlobStoreShape>()(
  "alchemy/Git/BlobStore",
) {}

// ─────────────────────────────────────────────────────────────────────────────
// R2 implementation
// ─────────────────────────────────────────────────────────────────────────────

const r2Error = (what: string) => (error: R2Error) =>
  new BlobStoreError({ reason: `${what}: ${error.message}` });

/**
 * Builds the R2-backed shape from an already-resolved bucket client.
 * Used directly by the Repo DO (which resolves its own binding) and by
 * the {@link BlobStoreR2} layer.
 */
export const makeBlobStoreR2 = (
  bucket: ReadWriteBucketClient,
): BlobStoreShape => ({
  get: (key, range) =>
    bucket.get(key, range === undefined ? undefined : { range }).pipe(
      Effect.mapError(r2Error(`get ${key}`)),
      Effect.map((object) =>
        object === null
          ? null
          : ({
              size: object.size,
              bytes: object
                .bytes()
                .pipe(Effect.mapError(r2Error(`read ${key}`))),
              stream: object.body.pipe(
                Stream.mapError(r2Error(`stream ${key}`)),
              ),
              readable: object.readable,
            } satisfies BlobBody),
      ),
    ),
  put: (key, body, options) => {
    // A stream body's own BlobStoreError joins R2's error union — map
    // only the R2 side, pass ours through.
    const write: Effect.Effect<
      unknown,
      R2Error | BlobStoreError,
      RuntimeContext
    > =
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
      Effect.map((object) =>
        object === null ? null : { key, size: object.size },
      ),
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
        abort: upload
          .abort()
          .pipe(Effect.mapError(r2Error(`abort ${key}`)), Effect.asVoid),
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
 * push spill live in the given bucket. Registers the bucket binding on
 * the host Worker.
 *
 * @layer
 * @provides Git.BlobStore
 */
export const BlobStoreR2 = (
  bucket: Parameters<typeof Cloudflare.R2.ReadWriteBucket>[0],
): Layer.Layer<BlobStore> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const client = yield* Cloudflare.R2.ReadWriteBucket(bucket);
      return makeBlobStoreR2(client);
    }),
  ).pipe(Layer.provide(Cloudflare.R2.ReadWriteBucketBinding)) as never;
