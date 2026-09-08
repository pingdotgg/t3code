// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/** Options for a local R2 bucket binding. */
export interface R2BucketProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /**
   * Bucket identifier, defaults to the binding name. Buckets with the same
   * identifier share data; the identifier also determines where data is
   * persisted on disk.
   */
  readonly id?: string;
}

/**
 * Service designator props passed to the R2 service entrypoint (`ctx.props`).
 * A single `r2` service hosts every bucket; each binding's designator carries
 * the bucket it should address.
 */
export interface R2ServiceProps {
  readonly bucketName: string;
}

export const SERVICE_R2 = "r2";
export const SERVICE_R2_STORAGE = "r2:storage";
export const R2_OBJECT_CLASS_NAME = "R2BucketObject";

export const BINDING_R2_OBJECT = "OBJECT";
export const BINDING_R2_BLOBS = "BLOBS";
export const BINDING_R2_ENABLE_CONTROL_ENDPOINTS = "ENABLE_CONTROL_ENDPOINTS";

/**
 * Internal header carrying the bucket name (URI-encoded) from the entry
 * `fetch` handler to the Durable Object, which needs it to namespace blob
 * paths on disk.
 */
export const HEADER_R2_BUCKET = "CF-Runtime-R2-Bucket";
/**
 * Internal header marking a control operation (fake timers, storage
 * inspection). The request body is JSON `{ name, args }`. Only honoured when
 * control endpoints are enabled; used by tests.
 */
export const HEADER_R2_CONTROL_OP = "CF-Runtime-R2-Control-Op";

// -----------------------------------------------------------------------------
// Conditional evaluation (`workers/r2/validator.worker.ts` upstream)
//
// Lives in this shared file (rather than the worker) so the runtime-agnostic
// RFC 7232 semantics can be unit tested from Node, mirroring Miniflare's
// `test/plugins/r2/validator.spec.ts`.
// -----------------------------------------------------------------------------

export type R2Etag =
  | { readonly type: "strong"; readonly value: string }
  | { readonly type: "weak"; readonly value: string }
  | { readonly type: "wildcard" };

/** Decoded form of workerd's `R2Conditional` binding metadata. */
export interface R2Conditional {
  /** Performs the operation if the object's ETag matches ("If-Match"). */
  readonly etagMatches?: ReadonlyArray<R2Etag>;
  /** Performs the operation if the object's ETag does NOT match ("If-None-Match"). */
  readonly etagDoesNotMatch?: ReadonlyArray<R2Etag>;
  /** Performs the operation if the object was uploaded BEFORE the given date ("If-Unmodified-Since"). */
  readonly uploadedBefore?: Date;
  /** Performs the operation if the object was uploaded AFTER the given date ("If-Modified-Since"). */
  readonly uploadedAfter?: Date;
  /** Truncates dates to seconds before performing comparisons. */
  readonly secondsGranularity?: boolean;
}

function identity(ms: number) {
  return ms;
}
function truncateToSeconds(ms: number) {
  return Math.floor(ms / 1000) * 1000;
}

function includesEtag(
  conditions: ReadonlyArray<R2Etag>,
  etag: string,
  comparison: "strong" | "weak",
) {
  // Adapted from internal R2 gateway implementation.
  for (const condition of conditions) {
    if (condition.type === "wildcard") return true;
    if (condition.value === etag) {
      if (condition.type === "strong" || comparison === "weak") return true;
    }
  }
  return false;
}

/**
 * Returns `true` iff the condition passed. Adapted from the internal R2
 * gateway implementation; see also
 * https://datatracker.ietf.org/doc/html/rfc7232#section-6.
 */
export function testR2Conditional(
  cond: R2Conditional,
  metadata?: { readonly etag: string; readonly uploaded: number },
): boolean {
  if (metadata === undefined) {
    const ifMatch = cond.etagMatches === undefined;
    const ifModifiedSince = cond.uploadedAfter === undefined;
    return ifMatch && ifModifiedSince;
  }

  const { etag, uploaded: lastModifiedRaw } = metadata;
  const ifMatch =
    cond.etagMatches === undefined ||
    includesEtag(cond.etagMatches, etag, "strong");
  const ifNoneMatch =
    cond.etagDoesNotMatch === undefined ||
    !includesEtag(cond.etagDoesNotMatch, etag, "weak");

  const maybeTruncate = cond.secondsGranularity ? truncateToSeconds : identity;
  const lastModified = maybeTruncate(lastModifiedRaw);
  const ifModifiedSince =
    cond.uploadedAfter === undefined ||
    maybeTruncate(cond.uploadedAfter.getTime()) < lastModified ||
    (cond.etagDoesNotMatch !== undefined && ifNoneMatch);
  const ifUnmodifiedSince =
    cond.uploadedBefore === undefined ||
    lastModified < maybeTruncate(cond.uploadedBefore.getTime()) ||
    (cond.etagMatches !== undefined && ifMatch);

  return ifMatch && ifNoneMatch && ifModifiedSince && ifUnmodifiedSince;
}
