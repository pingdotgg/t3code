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
 * - `Git.BlobStoreR2` — Cloudflare R2 over the existing
 *   `ReadWriteBucket` capability (the default).
 * - `Git.BlobStoreS3` — AWS S3 over the S3 object bindings.
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
 *
 * // The Worker picks the ReadWriteBucket implementation.
 * export default class GitHost extends Cloudflare.Worker<GitHost>()(
 *   "GitHost",
 *   { main: import.meta.url, ...Git.GIT_WORKER_OPTIONS },
 *   Effect.gen(function* () {
 *     return { fetch: yield* HttpRouter.toHttpEffect(GitLive) };
 *   }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
 * ) {}
 * ```
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
  readonly complete: (parts: ReadonlyArray<UploadedPart>) => Effect.Effect<void, BlobStoreError>;
  readonly abort: Effect.Effect<void, BlobStoreError>;
}

/** Sorts parts by number: stores validate the uniform-part rule against the list as given. */
export const orderedParts = (parts: ReadonlyArray<UploadedPart>): Array<UploadedPart> =>
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
  readonly head: (key: string) => Effect.Effect<BlobMeta | null, BlobStoreError, RuntimeContext>;
  /** Begin a multipart write (spilled push bodies of unknown length). */
  readonly multipart: (key: string) => Effect.Effect<BlobMultipart, BlobStoreError, RuntimeContext>;
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
  readonly list: (prefix: string) => Stream.Stream<BlobMeta, BlobStoreError, RuntimeContext>;
}

/**
 * The swappable bulk-byte store of the git service.
 *
 * @binding
 */
export class BlobStore extends Context.Service<BlobStore, BlobStoreShape>()(
  "alchemy/Git/BlobStore",
) {}
