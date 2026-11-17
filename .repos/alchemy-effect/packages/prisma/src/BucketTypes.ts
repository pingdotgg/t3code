import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";

/**
 * Failure of a Prisma Object Store operation. Every transport-level failure
 * (HTTP, SigV4, decoding) is normalized into this one error so callers never
 * have to match on the underlying S3 error union.
 */
export class BucketError extends Data.TaggedError("BucketError")<{
  message: string;
  cause: Error;
}> {}

/**
 * Metadata of a single stored object, independent of the transport used to
 * read it.
 */
export interface BucketObject {
  /**
   * Object key within the bucket.
   */
  key: string;
  /**
   * Size of the stored object in bytes.
   */
  size: number;
  /**
   * Entity tag of the stored object, without the surrounding quotes.
   */
  etag: string;
  /**
   * When the object was last written, when the store reports it.
   */
  lastModified: Date | undefined;
  /**
   * `Content-Type` the object was stored with, when set.
   */
  contentType: string | undefined;
  /**
   * User-defined metadata stored alongside the object.
   */
  metadata: Record<string, string>;
}

/**
 * An object together with its body. The body is a single-consumption stream:
 * read it either through `body` or through one of the buffering accessors,
 * once.
 */
export interface BucketObjectBody extends BucketObject {
  /**
   * Object bytes as a stream.
   */
  body: Stream.Stream<Uint8Array, BucketError>;
  /**
   * Buffer the whole body into an `ArrayBuffer`.
   */
  arrayBuffer(): Effect.Effect<ArrayBuffer, BucketError>;
  /**
   * Buffer the whole body into a `Uint8Array`.
   */
  bytes(): Effect.Effect<Uint8Array, BucketError>;
  /**
   * Buffer the whole body and decode it as UTF-8 text.
   */
  text(): Effect.Effect<string, BucketError>;
  /**
   * Buffer the whole body and parse it as JSON.
   */
  json<T>(): Effect.Effect<T, BucketError>;
}

/**
 * Values accepted as an object body by `put`.
 */
export type BucketBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | Stream.Stream<Uint8Array, unknown>;

/**
 * Byte range to read, expressed as an offset and an optional length. Omitting
 * `length` reads to the end of the object.
 */
export interface BucketRange {
  /**
   * Zero-based index of the first byte to read.
   */
  offset: number;
  /**
   * Number of bytes to read. Reads to the end of the object when omitted.
   */
  length?: number;
}

export interface GetOptions {
  /**
   * Read only part of the object.
   */
  range?: BucketRange;
}

export interface PutOptions {
  /**
   * `Content-Type` to store with the object.
   */
  contentType?: string;
  /**
   * Byte length of the body. Required by some stores for streaming bodies.
   */
  contentLength?: number;
  /**
   * `Cache-Control` to store with the object.
   */
  cacheControl?: string;
  /**
   * `Content-Disposition` to store with the object.
   */
  contentDisposition?: string;
  /**
   * `Content-Encoding` to store with the object.
   */
  contentEncoding?: string;
  /**
   * User-defined metadata to store alongside the object.
   */
  metadata?: Record<string, string>;
}

export interface ListOptions {
  /**
   * Only list keys starting with this prefix.
   */
  prefix?: string;
  /**
   * Roll keys sharing a prefix up to `delimitedPrefixes` at this separator.
   */
  delimiter?: string;
  /**
   * Continue a truncated listing from the previous result's `cursor`.
   */
  cursor?: string;
  /**
   * Maximum number of objects to return in one page.
   */
  limit?: number;
  /**
   * Start listing after this key.
   */
  startAfter?: string;
}

/**
 * One page of a listing. A truncated page always carries the cursor that
 * continues it, so `truncated` narrows `cursor`.
 */
export type ListResult =
  | {
      /**
       * Objects in this page of the listing.
       */
      objects: BucketObject[];
      /**
       * Common prefixes rolled up by `delimiter`.
       */
      delimitedPrefixes: string[];
      /**
       * More objects remain beyond this page.
       */
      truncated: true;
      /**
       * Cursor to pass as `ListOptions.cursor` for the next page.
       */
      cursor: string;
    }
  | {
      objects: BucketObject[];
      delimitedPrefixes: string[];
      /**
       * This page completes the listing.
       */
      truncated: false;
    };

export interface PresignGetOptions {
  /**
   * Seconds the minted URL stays valid.
   * @default 900
   */
  expiresIn?: number;
  /**
   * `Content-Type` the response is served with, signed into the URL as a
   * `response-content-type` override. The downloader sends nothing extra.
   */
  contentType?: string;
}

export interface PresignPutOptions {
  /**
   * Seconds the minted URL stays valid.
   * @default 900
   */
  expiresIn?: number;
  /**
   * `Content-Type` signed into the URL. An uploader using the presigned PUT
   * URL must send exactly this `Content-Type` or the signature check fails.
   */
  contentType?: string;
}

/**
 * Accessors for the values a bound `Prisma.BucketAccessKey` carries into the
 * host runtime — each is an Effect that resolves the value where it runs
 * (deploy-time output or the host environment at runtime).
 *
 * This is what a bucket binding hands to its `makeClient`, so an embedder can
 * reuse Alchemy's credential provisioning with a client of its own.
 */
export interface BucketCredentials {
  /**
   * S3-compatible endpoint URL the bucket is served from.
   */
  endpoint: Effect.Effect<string>;
  /**
   * Provider-side S3 bucket name, which is not the bucket's display name.
   */
  bucketName: Effect.Effect<string>;
  /**
   * S3 access key ID of the bound bucket key.
   */
  accessKeyId: Effect.Effect<string>;
  /**
   * S3 secret access key of the bound bucket key.
   */
  secretAccessKey: Effect.Effect<Redacted.Redacted<string>>;
}
