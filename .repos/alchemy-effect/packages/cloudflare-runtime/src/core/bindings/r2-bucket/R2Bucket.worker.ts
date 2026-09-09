// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local R2 bucket simulator, adapted from Miniflare's R2 plugin workers
 * (`workers-sdk/packages/miniflare/src/workers/r2/*`), collapsed into a
 * single worker. Utilities from Miniflare's `workers/shared/*` live in
 * `internal/shared.worker.ts`.
 *
 * A single `r2` service hosts every bucket. The default export is the entry
 * `fetch` handler that `r2Bucket` bindings target: it reads the bucket name
 * from `ctx.props` (set on the binding's service designator) and forwards the
 * request to the `R2BucketObject` Durable Object instance for that bucket.
 * The Durable Object speaks workerd's R2 binding HTTP protocol: object
 * metadata lives in Durable Object SQLite, values (and multipart parts) are
 * stored as blob files via the `r2:storage` disk service.
 *
 * This worker requires the `nodejs_compat` compatibility flag:
 * `node:crypto`'s `createHash("md5")` is needed to synchronously compute
 * multipart ETags inside SQLite transactions. Upstream's `Buffer` usages are
 * replaced with small hex/base64 helpers.
 */
import { createHash } from "node:crypto";
import type { BlobId, InclusiveRange } from "../../internal/shared.worker.ts";
import {
  assert,
  base64Decode,
  base64DecodeBytes,
  base64Encode,
  BlobStore,
  hexEncode,
  HttpError,
  maybeApply,
  Timers,
  utf8ByteLength,
} from "../../internal/shared.worker.ts";
import type {
  R2Conditional,
  R2Etag,
  R2ServiceProps,
} from "./R2BucketOptions.shared.ts";
import {
  BINDING_R2_BLOBS,
  BINDING_R2_ENABLE_CONTROL_ENDPOINTS,
  BINDING_R2_OBJECT,
  HEADER_R2_BUCKET,
  HEADER_R2_CONTROL_OP,
  testR2Conditional,
} from "./R2BucketOptions.shared.ts";

interface Env {
  [BINDING_R2_OBJECT]: DurableObjectNamespace;
  [BINDING_R2_BLOBS]: Fetcher;
  [BINDING_R2_ENABLE_CONTROL_ENDPOINTS]?: boolean;
}

export default {
  async fetch(request, env, ctx) {
    const { bucketName } = (ctx as { props: R2ServiceProps }).props;
    const stub = env[BINDING_R2_OBJECT].getByName(bucketName);
    const headers = new Headers(request.headers);
    headers.set(HEADER_R2_BUCKET, encodeURIComponent(bucketName));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
// Constants (`workers/r2/constants.ts`)
// -----------------------------------------------------------------------------

const R2Limits = {
  MAX_LIST_KEYS: 1000,
  MAX_KEY_SIZE: 1024,
  // https://developers.cloudflare.com/r2/platform/limits/
  MAX_VALUE_SIZE: 5_368_709_120 - 5_242_880, // 5 GiB - 5 MiB
  MAX_METADATA_SIZE: 2048, // 2048 B
  MIN_MULTIPART_PART_SIZE: 5 * 1024 * 1024,
  MIN_MULTIPART_PART_SIZE_TEST: 50,
} as const;

const R2Headers = {
  ERROR: "cf-r2-error",
  REQUEST: "cf-r2-request",
  METADATA_SIZE: "cf-r2-metadata-size",
} as const;

// -----------------------------------------------------------------------------
// Shared utilities (`workers/shared/{types,data,sync,range}.worker.ts`; the
// parts shared with other bindings live in `internal/shared.worker.ts`)
// -----------------------------------------------------------------------------

/** Waits for a dynamic number of in-flight tasks, like Go's `sync.WaitGroup`. */
class WaitGroup {
  #counter = 0;
  #resolveQueue: Array<() => void> = [];

  add(): void {
    this.#counter++;
  }

  done(): void {
    assert(this.#counter > 0);
    this.#counter--;
    if (this.#counter === 0) {
      let resolve: (() => void) | undefined;
      while ((resolve = this.#resolveQueue.shift()) !== undefined) resolve();
    }
  }

  wait(): Promise<void> {
    if (this.#counter === 0) return Promise.resolve();
    return new Promise((resolve) => this.#resolveQueue.push(resolve));
  }
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const HEX_REGEXP = /^[0-9a-f]*$/;

/**
 * Reads the first `prefixLength` bytes of `stream`, returning them along with
 * a stream of the rest. Used to split workerd's metadata-prefixed R2 `PUT`
 * bodies.
 */
async function readPrefix(
  stream: ReadableStream<Uint8Array>,
  prefixLength: number,
): Promise<[prefix: Uint8Array, rest: ReadableStream<Uint8Array>]> {
  const reader = stream.getReader({ mode: "byob" });
  const result = await reader.readAtLeast(
    prefixLength,
    new Uint8Array(prefixLength),
  );
  assert(result.value !== undefined);
  reader.releaseLock();
  // Without this `pipeThrough()`, getting uncaught `TypeError: Can't read from
  // request stream after response has been sent.`
  const rest = stream.pipeThrough(new IdentityTransformStream());
  return [result.value, rest];
}

// Matches case-insensitive string "bytes", ignoring surrounding whitespace,
// followed by "=" (example matches: "bytes=...", "ByTeS=...", "   bytes  =...")
const rangePrefixRegexp = /^ *bytes *=/i;

// Matches single range, with optional start/end numbers, ignoring whitespace
// (example matches: "1-2", "1-", "2-", "  1   -    2   ", "  -  " [note this
// last case is invalid and will be handled separately in `parseRanges`])
const rangeRegexp = /^ *(?<start>\d+)? *- *(?<end>\d+)? *$/;

/**
 * Parses an HTTP `Range` header (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range),
 * returning either:
 * - `undefined` indicating the range is unsatisfiable
 * - An empty array indicating the entire response should be returned
 * - A non-empty array of inclusive ranges of the response to return
 */
function parseRanges(
  rangeHeader: string,
  length: number,
): Array<InclusiveRange> | undefined {
  // Make sure unit is "bytes"
  const prefixMatch = rangePrefixRegexp.exec(rangeHeader);
  if (prefixMatch === null) return; // Invalid unit (Range Not Satisfiable)

  // Accept empty range header
  rangeHeader = rangeHeader.substring(prefixMatch[0].length);
  if (rangeHeader.trimStart() === "") return [];

  // Split ranges after prefix by ","
  const ranges = rangeHeader.split(",");
  const result: Array<InclusiveRange> = [];
  for (const range of ranges) {
    const match = rangeRegexp.exec(range);
    if (match === null) return; // Invalid range format (Range Not Satisfiable)
    const { start, end } = match.groups as { start?: string; end?: string };
    if (start !== undefined && end !== undefined) {
      const rangeStart = parseInt(start);
      let rangeEnd = parseInt(end);
      if (rangeStart > rangeEnd) return; // Start after end (Range Not Satisfiable)
      if (rangeStart >= length) return; // Start after content (Range Not Satisfiable)
      if (rangeEnd >= length) rangeEnd = length - 1;
      result.push({ start: rangeStart, end: rangeEnd });
    } else if (start !== undefined && end === undefined) {
      const rangeStart = parseInt(start);
      if (rangeStart >= length) return; // Start after content (Range Not Satisfiable)
      result.push({ start: rangeStart, end: length - 1 });
    } else if (start === undefined && end !== undefined) {
      const suffix = parseInt(end);
      if (suffix >= length) return []; // Entire Response
      if (suffix === 0) continue; // Empty range
      result.push({ start: length - suffix, end: length - 1 });
    } else {
      return; // Invalid range format, missing both start & end (Range Not Satisfiable)
    }
  }
  return result;
}

// -----------------------------------------------------------------------------
// Errors (`workers/r2/errors.worker.ts`)
// -----------------------------------------------------------------------------

const R2ErrorCode = {
  INTERNAL_ERROR: 10001,
  NO_SUCH_OBJECT_KEY: 10007,
  ENTITY_TOO_LARGE: 100100,
  ENTITY_TOO_SMALL: 10011,
  METADATA_TOO_LARGE: 10012,
  INVALID_OBJECT_NAME: 10020,
  INVALID_MAX_KEYS: 10022,
  NO_SUCH_UPLOAD: 10024,
  INVALID_PART: 10025,
  INVALID_ARGUMENT: 10029,
  PRECONDITION_FAILED: 10031,
  BAD_DIGEST: 10037,
  INVALID_RANGE: 10039,
  BAD_UPLOAD: 10048,
} as const;

class R2Error extends HttpError {
  object?: InternalR2Object;

  constructor(
    code: number,
    message: string,
    readonly v4Code: number,
  ) {
    super(code, message);
  }

  override toResponse() {
    if (this.object !== undefined) {
      const { metadataSize, value } = this.object.encode();
      return new Response(value, {
        status: this.code,
        headers: {
          [R2Headers.METADATA_SIZE]: `${metadataSize}`,
          "Content-Type": "application/json",
          [R2Headers.ERROR]: JSON.stringify({
            message: this.message,
            version: 1,
            // Note the lowercase 'c', which the runtime expects
            v4code: this.v4Code,
          }),
        },
      });
    }
    return new Response(null, {
      status: this.code,
      headers: {
        [R2Headers.ERROR]: JSON.stringify({
          message: this.message,
          version: 1,
          // Note the lowercase 'c', which the runtime expects
          v4code: this.v4Code,
        }),
      },
    });
  }

  attach(object: InternalR2Object) {
    this.object = object;
    return this;
  }
}

class InvalidMetadata extends R2Error {
  constructor() {
    super(400, "Metadata missing or invalid", R2ErrorCode.INVALID_ARGUMENT);
  }
}

class InternalError extends R2Error {
  constructor() {
    super(
      500,
      "We encountered an internal error. Please try again.",
      R2ErrorCode.INTERNAL_ERROR,
    );
  }
}

class NoSuchKey extends R2Error {
  constructor() {
    super(
      404,
      "The specified key does not exist.",
      R2ErrorCode.NO_SUCH_OBJECT_KEY,
    );
  }
}

class EntityTooLarge extends R2Error {
  constructor() {
    super(
      400,
      "Your proposed upload exceeds the maximum allowed object size.",
      R2ErrorCode.ENTITY_TOO_LARGE,
    );
  }
}

class EntityTooSmall extends R2Error {
  constructor() {
    super(
      400,
      "Your proposed upload is smaller than the minimum allowed object size.",
      R2ErrorCode.ENTITY_TOO_SMALL,
    );
  }
}

class MetadataTooLarge extends R2Error {
  constructor() {
    super(
      400,
      "Your metadata headers exceed the maximum allowed metadata size.",
      R2ErrorCode.METADATA_TOO_LARGE,
    );
  }
}

class BadDigest extends R2Error {
  constructor(
    algorithm: DigestAlgorithm,
    provided: Uint8Array,
    calculated: Uint8Array,
  ) {
    super(
      400,
      [
        `The ${algorithm} checksum you specified did not match what we received.`,
        `You provided a ${algorithm} checksum with value: ${hexEncode(provided)}`,
        `Actual ${algorithm} was: ${hexEncode(calculated)}`,
      ].join("\n"),
      R2ErrorCode.BAD_DIGEST,
    );
  }
}

class InvalidObjectName extends R2Error {
  constructor() {
    super(
      400,
      "The specified object name is not valid.",
      R2ErrorCode.INVALID_OBJECT_NAME,
    );
  }
}

class InvalidMaxKeys extends R2Error {
  constructor() {
    super(
      400,
      "MaxKeys params must be positive integer <= 1000.",
      R2ErrorCode.INVALID_MAX_KEYS,
    );
  }
}

class NoSuchUpload extends R2Error {
  constructor() {
    super(
      400,
      "The specified multipart upload does not exist.",
      R2ErrorCode.NO_SUCH_UPLOAD,
    );
  }
}

class InvalidPart extends R2Error {
  constructor() {
    super(
      400,
      "One or more of the specified parts could not be found.",
      R2ErrorCode.INVALID_PART,
    );
  }
}

class PreconditionFailed extends R2Error {
  constructor() {
    super(
      412,
      "At least one of the pre-conditions you specified did not hold.",
      R2ErrorCode.PRECONDITION_FAILED,
    );
  }
}

class InvalidRange extends R2Error {
  constructor() {
    super(
      416,
      "The requested range is not satisfiable",
      R2ErrorCode.INVALID_RANGE,
    );
  }
}

class BadUpload extends R2Error {
  constructor() {
    super(
      500,
      "There was a problem with the multipart upload.",
      R2ErrorCode.BAD_UPLOAD,
    );
  }
}

// -----------------------------------------------------------------------------
// Schemas (`workers/r2/schemas.worker.ts`)
//
// Upstream validates workerd's binding metadata with zod. workerd is a
// trusted client, so hand-written decoders that just normalise the payload
// (renames, date/number coercion, base64/hex decoding) are used instead.
// -----------------------------------------------------------------------------

type ObjectRow = {
  key: string;
  blob_id: string | null; // null if multipart
  version: string;
  size: number; // total size of object (all parts) in bytes
  etag: string; // hex MD5 hash if not multipart
  uploaded: number; // milliseconds since unix epoch
  checksums: string; // JSON-serialised `R2StringChecksums` (workers-types)
  http_metadata: string; // JSON-serialised `R2HTTPMetadata` (workers-types)
  custom_metadata: string; // JSON-serialised user-defined metadata
};
const MultipartUploadState = {
  IN_PROGRESS: 0,
  COMPLETED: 1,
  ABORTED: 2,
} as const;
type MultipartUploadRow = {
  upload_id: string;
  key: string;
  http_metadata: string; // JSON-serialised `R2HTTPMetadata` (workers-types)
  custom_metadata: string; // JSON-serialised user-defined metadata
  state: (typeof MultipartUploadState)[keyof typeof MultipartUploadState];
  // NOTE: we need to keep completed/aborted uploads around for referential
  // integrity, and because error messages are different when attempting to
  // upload parts to them
};
type MultipartPartRow = {
  upload_id: string;
  part_number: number;
  blob_id: string;
  size: number; // NOTE: used to identify which parts to read for range requests
  etag: string; // NOTE: multipart part ETag's are not MD5 checksums
  checksum_md5: string; // NOTE: used in construction of final object's ETag
  object_key: string | null; // null if in-progress upload
};
const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS _mf_objects (
    key TEXT PRIMARY KEY,
    blob_id TEXT,
    version TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    uploaded INTEGER NOT NULL,
    checksums TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_uploads (
    upload_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    http_metadata TEXT NOT NULL,
    custom_metadata TEXT NOT NULL,
    state TINYINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS _mf_multipart_parts (
    upload_id TEXT NOT NULL REFERENCES _mf_multipart_uploads(upload_id),
    part_number INTEGER NOT NULL,
    blob_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    etag TEXT NOT NULL,
    checksum_md5 TEXT NOT NULL,
    object_key TEXT REFERENCES _mf_objects(key) DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (upload_id, part_number)
);
`;
// NOTE: `object_key` foreign key constraint is deferred, meaning we can delete
// the linked object row, *then* the multipart part rows in a transaction,
// see https://www.sqlite.org/foreignkeys.html#fk_deferred for more details

// https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-api.capnp

interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

interface R2HttpFields {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: number;
}

interface R2PublishedPart {
  etag: string;
  part: number;
}

interface R2HeadRequest {
  method: "head";
  object: string;
}
interface R2GetRequest {
  method: "get";
  object: string;
  // Specifies that only a specific length (from an optional offset) or suffix
  // of bytes from the object should be returned. Refer to
  // https://developers.cloudflare.com/r2/runtime-apis/#ranged-reads.
  range?: R2Range;
  rangeHeader?: string;
  // Specifies that the object should only be returned given satisfaction of
  // certain conditions in the R2Conditional.
  onlyIf?: R2Conditional;
}
interface R2PutRequest {
  method: "put";
  object: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HttpFields;
  onlyIf?: R2Conditional;
  md5?: Uint8Array; // (intentionally sent base64-encoded, unlike the others)
  sha1?: Uint8Array;
  sha256?: Uint8Array;
  sha384?: Uint8Array;
  sha512?: Uint8Array;
}
interface R2CreateMultipartUploadRequest {
  method: "createMultipartUpload";
  object: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HttpFields;
}
interface R2UploadPartRequest {
  method: "uploadPart";
  object: string;
  uploadId: string;
  partNumber: number;
}
interface R2CompleteMultipartUploadRequest {
  method: "completeMultipartUpload";
  object: string;
  uploadId: string;
  parts: Array<R2PublishedPart>;
}
interface R2AbortMultipartUploadRequest {
  method: "abortMultipartUpload";
  object: string;
  uploadId: string;
}
interface R2ListRequest {
  method: "list";
  limit?: number;
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  startAfter?: string;
  include?: Array<"httpMetadata" | "customMetadata">;
}
type R2DeleteRequest =
  | { method: "delete"; object: string }
  | { method: "delete"; objects: Array<string> };

type R2BindingRequest =
  | R2HeadRequest
  | R2GetRequest
  | R2PutRequest
  | R2CreateMultipartUploadRequest
  | R2UploadPartRequest
  | R2CompleteMultipartUploadRequest
  | R2AbortMultipartUploadRequest
  | R2ListRequest
  | R2DeleteRequest;

type OmitRequest<T> = Omit<T, "method" | "object">;
type InternalR2GetOptions = OmitRequest<R2GetRequest>;
type InternalR2PutOptions = OmitRequest<R2PutRequest>;
type InternalR2ListOptions = OmitRequest<R2ListRequest>;
type InternalR2CreateMultipartUploadOptions =
  OmitRequest<R2CreateMultipartUploadRequest>;

/* Raw (wire-format) shapes, before decoding */
interface RawR2Conditional {
  etagMatches?: Array<R2Etag>;
  etagDoesNotMatch?: Array<R2Etag>;
  uploadedBefore?: number | string;
  uploadedAfter?: number | string;
  secondsGranularity?: boolean;
}
type RawRecord = Array<{ k: string; v: string }>;
interface RawR2HttpFields extends Omit<R2HttpFields, "cacheExpiry"> {
  cacheExpiry?: number | string;
}

function decodeConditional(
  raw: RawR2Conditional | undefined,
): R2Conditional | undefined {
  if (raw === undefined) return undefined;
  return {
    etagMatches: raw.etagMatches,
    etagDoesNotMatch: raw.etagDoesNotMatch,
    uploadedBefore: maybeApply(
      (value) => new Date(Number(value)),
      raw.uploadedBefore,
    ),
    uploadedAfter: maybeApply(
      (value) => new Date(Number(value)),
      raw.uploadedAfter,
    ),
    secondsGranularity: raw.secondsGranularity,
  };
}

function decodeRecord(
  raw: RawRecord | undefined,
): Record<string, string> | undefined {
  return maybeApply(
    (entries) => Object.fromEntries(entries.map(({ k, v }) => [k, v])),
    raw,
  );
}

function decodeHttpFields(
  raw: RawR2HttpFields | undefined,
): R2HttpFields | undefined {
  if (raw === undefined) return undefined;
  return { ...raw, cacheExpiry: maybeApply(Number, raw.cacheExpiry) };
}

function decodeRange(raw: R2Range | undefined): R2Range | undefined {
  if (raw === undefined) return undefined;
  return {
    offset: maybeApply(Number, raw.offset),
    length: maybeApply(Number, raw.length),
    suffix: maybeApply(Number, raw.suffix),
  };
}

// oxlint-disable-next-line no-explicit-any -- trusted wire format from workerd
function decodeBindingRequest(raw: any): R2BindingRequest {
  switch (raw.method) {
    case "head":
      return { method: "head", object: raw.object };
    case "get":
      return {
        method: "get",
        object: raw.object,
        range: decodeRange(raw.range),
        rangeHeader: raw.rangeHeader,
        onlyIf: decodeConditional(raw.onlyIf),
      };
    case "put":
      return {
        method: "put",
        object: raw.object,
        customMetadata: decodeRecord(raw.customFields),
        httpMetadata: decodeHttpFields(raw.httpFields),
        onlyIf: decodeConditional(raw.onlyIf),
        md5: maybeApply(base64DecodeBytes, raw.md5),
        sha1: maybeApply(hexDecode, raw.sha1),
        sha256: maybeApply(hexDecode, raw.sha256),
        sha384: maybeApply(hexDecode, raw.sha384),
        sha512: maybeApply(hexDecode, raw.sha512),
      };
    case "createMultipartUpload":
      return {
        method: "createMultipartUpload",
        object: raw.object,
        customMetadata: decodeRecord(raw.customFields),
        httpMetadata: decodeHttpFields(raw.httpFields),
      };
    case "uploadPart":
      return {
        method: "uploadPart",
        object: raw.object,
        uploadId: raw.uploadId,
        partNumber: raw.partNumber,
      };
    case "completeMultipartUpload":
      return {
        method: "completeMultipartUpload",
        object: raw.object,
        uploadId: raw.uploadId,
        parts: raw.parts,
      };
    case "abortMultipartUpload":
      return {
        method: "abortMultipartUpload",
        object: raw.object,
        uploadId: raw.uploadId,
      };
    case "list":
      return {
        method: "list",
        limit: maybeApply(Number, raw.limit),
        prefix: raw.prefix,
        cursor: raw.cursor,
        delimiter: raw.delimiter,
        startAfter: raw.startAfter,
        include: maybeApply(
          (values: Array<0 | 1>) =>
            values.map((value): "httpMetadata" | "customMetadata" =>
              value === 0 ? "httpMetadata" : "customMetadata",
            ),
          raw.include,
        ),
      };
    case "delete":
      return "object" in raw
        ? { method: "delete", object: raw.object }
        : { method: "delete", objects: raw.objects };
    default:
      throw new InvalidMetadata();
  }
}

/* Response formats, returned to the Workers runtime */
interface R2HeadResponse {
  name: string;
  version: string;
  size: number;
  etag: string;
  uploaded: number;
  // Optional: https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L81
  httpFields?: R2HttpFields;
  // Optional: https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L113
  customFields?: RawRecord;
  // Optional: https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L130
  range?: R2Range;
  // Optional: https://github.com/cloudflare/workerd/blob/4290f9717bc94647d9c8afd29602cdac97fdff1b/src/workerd/api/r2-bucket.c%2B%2B#L140
  checksums?: {
    0?: string;
    1?: string;
    2?: string;
    3?: string;
    4?: string;
  };
}
interface R2CreateMultipartUploadResponse {
  uploadId: string;
}
interface R2UploadPartResponse {
  etag: string;
}

// -----------------------------------------------------------------------------
// R2 objects (`workers/r2/r2Object.worker.ts`)
// -----------------------------------------------------------------------------

interface EncodedMetadata {
  metadataSize: number;
  value: ReadableStream<Uint8Array>;
  size: number;
}

class InternalR2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: number;
  readonly httpMetadata: R2HttpFields;
  readonly customMetadata: Record<string, string>;
  readonly range?: R2Range;
  readonly checksums: R2StringChecksums;

  constructor(row: Omit<ObjectRow, "blob_id">, range?: R2Range) {
    this.key = row.key;
    this.version = row.version;
    this.size = row.size;
    this.etag = row.etag;
    this.uploaded = row.uploaded;
    this.httpMetadata = JSON.parse(row.http_metadata);
    this.customMetadata = JSON.parse(row.custom_metadata);
    this.range = range;

    // For non-multipart uploads, we always need to store an MD5 hash in
    // `checksums`. To avoid data duplication, we just use `etag` for this.
    const checksums: R2StringChecksums = JSON.parse(row.checksums);
    if (this.etag.length === 32 && HEX_REGEXP.test(this.etag)) {
      checksums.md5 = row.etag;
    }
    this.checksums = checksums;
  }

  // Format for return to the Workers Runtime
  rawProperties(): R2HeadResponse {
    return {
      name: this.key,
      version: this.version,
      size: this.size,
      etag: this.etag,
      uploaded: this.uploaded,
      httpFields: this.httpMetadata,
      customFields: Object.entries(this.customMetadata).map(([k, v]) => ({
        k,
        v,
      })),
      range: this.range,
      checksums: {
        0: this.checksums.md5,
        1: this.checksums.sha1,
        2: this.checksums.sha256,
        3: this.checksums.sha384,
        4: this.checksums.sha512,
      },
    };
  }

  encode(): EncodedMetadata {
    const json = JSON.stringify(this.rawProperties());
    const blob = new Blob([json]);
    return { metadataSize: blob.size, value: blob.stream(), size: blob.size };
  }

  static encodeMultiple(objects: InternalR2Objects): EncodedMetadata {
    const json = JSON.stringify({
      ...objects,
      objects: objects.objects.map((o) => o.rawProperties()),
    });
    const blob = new Blob([json]);
    return { metadataSize: blob.size, value: blob.stream(), size: blob.size };
  }
}

class InternalR2ObjectBody extends InternalR2Object {
  constructor(
    metadata: Omit<ObjectRow, "blob_id">,
    readonly body: ReadableStream<Uint8Array>,
    range?: R2Range,
  ) {
    super(metadata, range);
  }

  override encode(): EncodedMetadata {
    const { metadataSize, value: metadata } = super.encode();
    const size = this.range?.length ?? this.size;
    const identity = new FixedLengthStream(size + metadataSize);
    void metadata
      .pipeTo(identity.writable, { preventClose: true })
      .then(() => this.body.pipeTo(identity.writable));
    return {
      metadataSize: metadataSize,
      value: identity.readable,
      size,
    };
  }
}

interface InternalR2Objects {
  // An array of objects matching the list request.
  objects: Array<InternalR2Object>;
  // If true, indicates there are more results to be retrieved for the current
  // list request.
  truncated: boolean;
  // A token that can be passed to future list calls to resume listing from
  // that point. Only present if truncated is true.
  cursor?: string;
  // If a delimiter has been specified, contains all prefixes between the
  // specified prefix and the next occurrence of the delimiter. For example, if
  // no prefix is provided and the delimiter is "/", "foo/bar/baz" would return
  // "foo" as a delimited prefix. If "foo/" was passed as a prefix with the
  // same structure and delimiter, "foo/bar" would be returned as a delimited
  // prefix.
  delimitedPrefixes: Array<string>;
}

// -----------------------------------------------------------------------------
// Validation (`workers/r2/validator.worker.ts`)
// -----------------------------------------------------------------------------

const R2_HASH_ALGORITHMS = [
  { name: "MD5", field: "md5" },
  { name: "SHA-1", field: "sha1" },
  { name: "SHA-256", field: "sha256" },
  { name: "SHA-384", field: "sha384" },
  { name: "SHA-512", field: "sha512" },
] as const;
type R2Hashes = Partial<
  Record<(typeof R2_HASH_ALGORITHMS)[number]["field"], Uint8Array>
>;
type DigestAlgorithm = (typeof R2_HASH_ALGORITHMS)[number]["name"];

function serialisedLength(x: string) {
  // Adapted from internal R2 gateway implementation
  for (let i = 0; i < x.length; i++) {
    if (x.charCodeAt(i) >= 256) return x.length * 2;
  }
  return x.length;
}

class Validator {
  hash(
    digests: Map<DigestAlgorithm, Uint8Array>,
    hashes: R2Hashes,
  ): R2StringChecksums {
    const checksums: R2StringChecksums = {};
    for (const { name, field } of R2_HASH_ALGORITHMS) {
      const providedHash = hashes[field];
      if (providedHash !== undefined) {
        const computedHash = digests.get(name);
        // Should've computed all required digests
        assert(computedHash !== undefined);
        if (!bytesEqual(providedHash, computedHash)) {
          throw new BadDigest(name, providedHash, computedHash);
        }
        // Store computed hash to ensure consistent casing in returned
        // checksums from `R2Object`
        checksums[field] = hexEncode(computedHash);
      }
    }
    return checksums;
  }

  condition(
    meta?: Pick<InternalR2Object, "etag" | "uploaded">,
    onlyIf?: R2Conditional,
  ): Validator {
    if (onlyIf !== undefined && !testR2Conditional(onlyIf, meta)) {
      throw new PreconditionFailed();
    }
    return this;
  }

  range(
    options: Pick<InternalR2GetOptions, "rangeHeader" | "range">,
    size: number,
  ): InclusiveRange | undefined {
    if (options.rangeHeader !== undefined) {
      const ranges = parseRanges(options.rangeHeader, size);
      // If the header contained a single range, use it. Otherwise, if the
      // header was invalid, or contained multiple ranges, just return the full
      // response (by returning undefined from this function).
      if (ranges?.length === 1) return ranges[0];
    } else if (options.range !== undefined) {
      let { offset, length, suffix } = options.range;
      // Eliminate suffix if specified
      if (suffix !== undefined) {
        if (suffix <= 0) throw new InvalidRange();
        if (suffix > size) suffix = size;
        offset = size - suffix;
        length = suffix;
      }
      // Validate offset and length
      if (offset === undefined) offset = 0;
      if (length === undefined) length = size - offset;
      if (offset < 0 || offset > size || length <= 0) throw new InvalidRange();
      // Clamp length to maximum
      if (offset + length > size) length = size - offset;
      // Convert to inclusive range
      return { start: offset, end: offset + length - 1 };
    }
  }

  size(size: number): Validator {
    if (size > R2Limits.MAX_VALUE_SIZE) {
      throw new EntityTooLarge();
    }
    return this;
  }

  metadataSize(customMetadata?: Record<string, string>): Validator {
    if (customMetadata === undefined) return this;
    let metadataLength = 0;
    for (const [key, value] of Object.entries(customMetadata)) {
      metadataLength += serialisedLength(key) + serialisedLength(value);
    }
    if (metadataLength > R2Limits.MAX_METADATA_SIZE) {
      throw new MetadataTooLarge();
    }
    return this;
  }

  key(key: string): Validator {
    const keyLength = utf8ByteLength(key);
    if (keyLength > R2Limits.MAX_KEY_SIZE) {
      throw new InvalidObjectName();
    }
    return this;
  }

  limit(limit?: number): Validator {
    if (limit !== undefined && (limit < 1 || limit > R2Limits.MAX_LIST_KEYS)) {
      throw new InvalidMaxKeys();
    }
    return this;
  }
}

// -----------------------------------------------------------------------------
// R2 bucket Durable Object (`workers/r2/bucket.worker.ts`)
// -----------------------------------------------------------------------------
//
// This implements Miniflare's R2 simulator, supporting both single and
// multipart uploads.
//
// ===== Notes on Multipart Uploads =====
//
// Multipart uploads are created and later resumed. When creating a multipart
// upload, we store an upload record, containing passed HTTP and custom
// metadata. This record serves as a marker for the upload, and is used by
// other methods to check the upload exists.
//
// A new part record is stored for each uploaded part. Each part gets an
// associated ETag, which must be used in conjunction with the part number when
// completing an upload. If a part is uploaded with the same part number as an
// existing part, it will override it.
//
// To complete a multipart upload, an array of part number and ETag objects is
// required. We add an object record as usual, but without a body. The
// selected parts have their records updated to point to the body. This means
// we don't need to load all parts into memory, concatenate them, and write
// them back out. An upload can also be aborted, in which case all its parts
// are deleted.
//
// Note that when completing or aborting an upload, the upload record is NOT
// deleted. This is because uploads can be aborted more than once, and even
// aborted after completion (although in this case, aborting is a no-op). We
// need to be able to distinguish between a completed upload, an aborted
// upload and an upload that never existed to handle this, and match R2's
// error messages.
//
// If regular `R2Bucket#{put,delete}()` methods are called on completed
// multipart objects, they will delete all parts in addition to the object
// itself. `R2Bucket#{put,delete}()` will never delete parts for in-progress
// uploads. `R2Bucket#{head,get,list}()` will never return data from
// in-progress uploads.

class DigestingStream<
  Algorithm extends DigestAlgorithm = DigestAlgorithm,
> extends TransformStream<Uint8Array, Uint8Array> {
  readonly digests: Promise<Map<Algorithm, Uint8Array>>;

  constructor(algorithms: Array<Algorithm>) {
    let resolveDigests!: (digests: Map<Algorithm, Uint8Array>) => void;
    const digests = new Promise<Map<Algorithm, Uint8Array>>(
      (resolve) => (resolveDigests = resolve),
    );
    const hashes = algorithms.map((algorithm) => {
      const stream = new crypto.DigestStream(algorithm);
      const writer = stream.getWriter();
      return { stream, writer };
    });
    super({
      async transform(chunk, controller) {
        for (const hash of hashes) await hash.writer.write(chunk);
        controller.enqueue(chunk);
      },
      async flush() {
        const result = new Map<Algorithm, Uint8Array>();
        for (let i = 0; i < hashes.length; i++) {
          await hashes[i].writer.close();
          result.set(
            algorithms[i],
            new Uint8Array(await hashes[i].stream.digest),
          );
        }
        resolveDigests(result);
      },
    });
    this.digests = digests;
  }
}

const validate = new Validator();
const decoder = new TextDecoder();

function generateVersion() {
  return hexEncode(crypto.getRandomValues(new Uint8Array(16)));
}
function generateId() {
  return base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(128)));
}
function generateMultipartEtag(md5Hexes: Array<string>) {
  // https://stackoverflow.com/a/19896823
  // `createHash` is used (instead of `crypto.subtle.digest` or
  // `crypto.DigestStream`) because multipart etags are computed inside SQLite
  // transactions, which cannot await.
  const hash = createHash("md5");
  for (const md5Hex of md5Hexes) hash.update(md5Hex, "hex");
  return `${hash.digest("hex")}-${md5Hexes.length}`;
}

function rangeOverlaps(a: InclusiveRange, b: InclusiveRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

async function decodeMetadata(req: Request) {
  const metadataSize = parseInt(
    req.headers.get(R2Headers.METADATA_SIZE) ?? "NaN",
  );
  if (Number.isNaN(metadataSize)) throw new InvalidMetadata();

  assert(req.body !== null);
  const body = req.body as ReadableStream<Uint8Array>;

  // Read just metadata from body stream
  const [metadataBuffer, value] = await readPrefix(body, metadataSize);
  const metadataJson = decoder.decode(metadataBuffer);
  let metadata: R2BindingRequest;
  try {
    metadata = decodeBindingRequest(JSON.parse(metadataJson));
  } catch (e) {
    if (e instanceof R2Error) throw e;
    throw new InvalidMetadata();
  }

  return { metadata, metadataSize, value };
}
function decodeHeaderMetadata(req: Request) {
  const header = req.headers.get(R2Headers.REQUEST);
  if (header === null) throw new InvalidMetadata();
  return decodeBindingRequest(JSON.parse(header));
}

function encodeResult(
  result: InternalR2Object | InternalR2ObjectBody | InternalR2Objects,
) {
  let encoded: EncodedMetadata;
  if (result instanceof InternalR2Object) {
    encoded = result.encode();
  } else {
    encoded = InternalR2Object.encodeMultiple(result);
  }

  return new Response(encoded.value, {
    headers: {
      [R2Headers.METADATA_SIZE]: `${encoded.metadataSize}`,
      "Content-Type": "application/json",
      "Content-Length": `${encoded.size}`,
    },
  });
}
function encodeJSONResult(
  result: R2CreateMultipartUploadResponse | R2UploadPartResponse,
) {
  const encoded = JSON.stringify(result);
  return new Response(encoded, {
    headers: {
      [R2Headers.METADATA_SIZE]: `${utf8ByteLength(encoded)}`,
      "Content-Type": "application/json",
    },
  });
}

function sqlStmts(storage: DurableObjectStorage) {
  const sql = storage.sql;

  const getPreviousByKey = (key: string) =>
    sql
      .exec<Pick<ObjectRow, "blob_id" | "etag" | "uploaded">>(
        "SELECT blob_id, etag, uploaded FROM _mf_objects WHERE key = ?1",
        key,
      )
      .toArray()
      .at(0);
  const getByKey = (key: string) =>
    sql
      .exec<ObjectRow>(
        `SELECT key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata
        FROM _mf_objects WHERE key = ?1`,
        key,
      )
      .toArray()
      .at(0);
  const putRow = (row: ObjectRow) =>
    sql.exec(
      `INSERT OR REPLACE INTO _mf_objects (key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      row.key,
      row.blob_id,
      row.version,
      row.size,
      row.etag,
      row.uploaded,
      row.checksums,
      row.http_metadata,
      row.custom_metadata,
    );
  const deleteByKey = (key: string) =>
    sql
      .exec<Pick<ObjectRow, "blob_id">>(
        "DELETE FROM _mf_objects WHERE key = ?1 RETURNING blob_id",
        key,
      )
      .toArray()
      .at(0);
  const deletePartsByKey = (objectKey: string) =>
    sql
      .exec<Pick<MultipartPartRow, "blob_id">>(
        "DELETE FROM _mf_multipart_parts WHERE object_key = ?1 RETURNING blob_id",
        objectKey,
      )
      .toArray();
  const listPartsByKey = (objectKey: string) =>
    sql
      .exec<Pick<MultipartPartRow, "blob_id" | "size">>(
        // Size included for range requests, so we only need to read blobs
        // containing the required data
        "SELECT blob_id, size FROM _mf_multipart_parts WHERE object_key = ?1 ORDER BY part_number",
        objectKey,
      )
      .toArray();
  const getUploadState = (uploadId: string, key: string) =>
    sql
      .exec<Pick<MultipartUploadRow, "state">>(
        "SELECT state FROM _mf_multipart_uploads WHERE upload_id = ?1 AND key = ?2",
        uploadId,
        key,
      )
      .toArray()
      .at(0);
  const updateUploadState = (
    uploadId: string,
    state: MultipartUploadRow["state"],
  ) =>
    sql.exec(
      "UPDATE _mf_multipart_uploads SET state = ?2 WHERE upload_id = ?1",
      uploadId,
      state,
    );

  interface ListParams {
    limit: number;
    prefix: string;
    start_after: string | null;
  }
  const listWithoutDelimiter = <ExtraColumns extends Array<keyof ObjectRow>>(
    ...extraColumns: ExtraColumns
  ) => {
    const columns: Array<keyof ObjectRow> = [
      "key",
      "version",
      "size",
      "etag",
      "uploaded",
      "checksums",
      ...extraColumns,
    ];
    const query = `
      SELECT ${columns.join(", ")}
      FROM _mf_objects
      WHERE substr(key, 1, length(?1)) = ?1
      AND (?2 IS NULL OR key > ?2)
      ORDER BY key LIMIT ?3
    `;
    return (params: ListParams) =>
      sql
        .exec<
          Omit<ObjectRow, "blob_id"> & Pick<ObjectRow, ExtraColumns[number]>
        >(query, params.prefix, params.start_after, params.limit)
        .toArray();
  };

  return {
    getByKey,
    getPartsByKey: (key: string) =>
      storage.transactionSync(() => {
        const row = getByKey(key);
        if (row === undefined) return;
        if (row.blob_id === null) {
          // If this is a multipart object, also return the parts
          return { row, parts: listPartsByKey(key) };
        } else {
          // Otherwise, just return the row
          return { row };
        }
      }),
    put: (newRow: ObjectRow, onlyIf?: R2Conditional) =>
      storage.transactionSync(() => {
        const key = newRow.key;
        const row = getPreviousByKey(key);
        if (onlyIf !== undefined) validate.condition(row, onlyIf);
        putRow(newRow);
        const maybeOldBlobId = row?.blob_id;
        if (maybeOldBlobId === undefined) {
          return [];
        } else if (maybeOldBlobId === null) {
          // If blob_id is null, this was a multipart object, so delete all
          // multipart parts
          return deletePartsByKey(key).map(({ blob_id }) => blob_id);
        } else {
          return [maybeOldBlobId];
        }
      }),
    deleteByKeys: (keys: Array<string>) =>
      storage.transactionSync(() => {
        const oldBlobIds: Array<string> = [];
        for (const key of keys) {
          const row = deleteByKey(key);
          const maybeOldBlobId = row?.blob_id;
          if (maybeOldBlobId === null) {
            // If blob_id is null, this was a multipart object, so delete all
            // multipart parts
            for (const partRow of deletePartsByKey(key))
              oldBlobIds.push(partRow.blob_id);
          } else if (maybeOldBlobId !== undefined) {
            oldBlobIds.push(maybeOldBlobId);
          }
        }
        return oldBlobIds;
      }),

    listWithoutDelimiter: listWithoutDelimiter(),
    listHttpMetadataWithoutDelimiter: listWithoutDelimiter("http_metadata"),
    listCustomMetadataWithoutDelimiter: listWithoutDelimiter("custom_metadata"),
    listHttpCustomMetadataWithoutDelimiter: listWithoutDelimiter(
      "http_metadata",
      "custom_metadata",
    ),
    listMetadata: (params: ListParams & { delimiter: string }) =>
      sql
        .exec<
          Omit<ObjectRow, "key" | "blob_id"> & {
            last_key: string;
            delimited_prefix_or_key: `dlp:${string}` | `key:${string}`;
          }
        >(
          `
          SELECT
            -- When grouping by a delimited prefix, this will give us the last key with that prefix.
            --   NOTE: we'll use this for the next cursor. If we didn't return the last key, the next page may return the
            --   same delimited prefix. Essentially, we're skipping over all keys with this group's delimited prefix.
            -- When grouping by a key, this will just give us the key.
            max(key) AS last_key,
            iif(
                -- Try get 1-indexed position \`i\` of ?4 (delimiter) in rest of key after ?1 (prefix)...
                                                        instr(substr(key, length(?1) + 1), ?4),
                -- ...if found, we have a delimited prefix of the prefix followed by the rest of key up to and including the delimiter
                'dlp:' || substr(key, 1, length(?1) + instr(substr(key, length(?1) + 1), ?4) + length(?4) - 1),
                -- ...otherwise, we just have a regular key
                'key:' || key
            ) AS delimited_prefix_or_key,
            -- NOTE: we'll ignore metadata for delimited prefix rows, so it doesn't matter which keys' we return
            version, size, etag, uploaded, checksums, http_metadata, custom_metadata
          FROM _mf_objects
          WHERE substr(key, 1, length(?1)) = ?1
          AND (?2 IS NULL OR key > ?2)
          GROUP BY delimited_prefix_or_key -- Group keys with same delimited prefix into a row, leaving others in their own rows
          ORDER BY last_key LIMIT ?3
          `,
          params.prefix,
          params.start_after,
          params.limit,
          params.delimiter,
        )
        .toArray(),

    createMultipartUpload: (row: Omit<MultipartUploadRow, "state">) =>
      sql.exec(
        `INSERT INTO _mf_multipart_uploads (upload_id, key, http_metadata, custom_metadata)
        VALUES (?1, ?2, ?3, ?4)`,
        row.upload_id,
        row.key,
        row.http_metadata,
        row.custom_metadata,
      ),
    putPart: (key: string, newRow: Omit<MultipartPartRow, "object_key">) =>
      storage.transactionSync(() => {
        // 1. Check the upload exists and is in-progress
        const uploadRow = getUploadState(newRow.upload_id, key);
        if (uploadRow?.state !== MultipartUploadState.IN_PROGRESS) {
          throw new NoSuchUpload();
        }

        // 2. Check if we have an existing part with this number, then upsert
        const partRow = sql
          .exec<Pick<MultipartPartRow, "blob_id">>(
            // Get part number's previous blob ID to garbage collect
            "SELECT blob_id FROM _mf_multipart_parts WHERE upload_id = ?1 AND part_number = ?2",
            newRow.upload_id,
            newRow.part_number,
          )
          .toArray()
          .at(0);
        sql.exec(
          `INSERT OR REPLACE INTO _mf_multipart_parts (upload_id, part_number, blob_id, size, etag, checksum_md5)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          newRow.upload_id,
          newRow.part_number,
          newRow.blob_id,
          newRow.size,
          newRow.etag,
          newRow.checksum_md5,
        );
        return partRow?.blob_id;
      }),
    completeMultipartUpload: (
      key: string,
      uploadId: string,
      selectedParts: Array<R2PublishedPart>,
      minPartSize: number,
    ) =>
      storage.transactionSync(() => {
        // 1. Check the upload exists and is in-progress
        const uploadRow = sql
          .exec<
            Pick<
              MultipartUploadRow,
              "http_metadata" | "custom_metadata" | "state"
            >
          >(
            "SELECT http_metadata, custom_metadata, state FROM _mf_multipart_uploads WHERE upload_id = ?1 AND key = ?2",
            uploadId,
            key,
          )
          .toArray()
          .at(0);
        if (uploadRow === undefined) {
          throw new InternalError();
        } else if (uploadRow.state > MultipartUploadState.IN_PROGRESS) {
          throw new NoSuchUpload();
        }

        // 2. Check all selected part numbers are unique
        const partNumberSet = new Set<number>();
        for (const { part } of selectedParts) {
          if (partNumberSet.has(part)) throw new InternalError();
          partNumberSet.add(part);
        }

        // 3. Get metadata for all uploaded parts, checking all selected parts
        //    exist
        const uploadedPartRows = sql
          .exec<Omit<MultipartPartRow, "blob_id">>(
            `SELECT upload_id, part_number, blob_id, size, etag, checksum_md5, object_key
            FROM _mf_multipart_parts WHERE upload_id = ?1`,
            uploadId,
          )
          .toArray();
        const uploadedParts = new Map<
          /* part number */ number,
          Omit<MultipartPartRow, "blob_id">
        >();
        for (const row of uploadedPartRows) {
          uploadedParts.set(row.part_number, row);
        }
        const parts = selectedParts.map((selectedPart) => {
          // Try find matching uploaded part. If part couldn't be found, or
          // ETags don't match, throw.
          const uploadedPart = uploadedParts.get(selectedPart.part);
          // (if an uploaded part couldn't be found with the selected part
          // number, `uploadedPart?.etag` will be `undefined`, which will never
          // match `selectedPart.etag`, as we've validated it's a string)
          if (uploadedPart?.etag !== selectedPart.etag) {
            throw new InvalidPart();
          }
          return uploadedPart;
        });
        // `parts` now contains a list of selected parts' metadata.

        // 4. Check all but last part meets minimum size requirements. First
        //    check this in argument order, throwing a friendly error...
        for (const part of parts.slice(0, -1)) {
          if (part.size < minPartSize) {
            throw new EntityTooSmall();
          }
        }
        //    ...then check again in ascending part number order, throwing an
        //    internal error. We won't know where the current last element ends
        //    up in the sort, so we just check all parts again.
        //
        //    Also check that all but the last parts are the same size...
        parts.sort((a, b) => a.part_number - b.part_number);
        let partSize: number | undefined;
        for (const part of parts.slice(0, -1)) {
          partSize ??= part.size;
          if (part.size < minPartSize || part.size !== partSize) {
            throw new BadUpload();
          }
        }
        //    ...and the last part is not greater than all others
        //    (if part size is defined, we must have at least one part)
        if (partSize !== undefined && parts[parts.length - 1].size > partSize) {
          throw new BadUpload();
        }

        // 5. Get existing upload if any, and delete previous multipart parts
        const oldBlobIds: Array<string> = [];
        const existingRow = getPreviousByKey(key);
        const maybeOldBlobId = existingRow?.blob_id;
        if (maybeOldBlobId === null) {
          // If blob_id is null, this was a multipart object, so delete all
          // multipart parts
          for (const partRow of deletePartsByKey(key))
            oldBlobIds.push(partRow.blob_id);
        } else if (maybeOldBlobId !== undefined) {
          oldBlobIds.push(maybeOldBlobId);
        }

        // 6. Write object to the database, and link parts with object
        const totalSize = parts.reduce((acc, { size }) => acc + size, 0);
        const etag = generateMultipartEtag(
          parts.map(({ checksum_md5 }) => checksum_md5),
        );
        const newRow: ObjectRow = {
          key,
          blob_id: null,
          version: generateVersion(),
          size: totalSize,
          etag,
          uploaded: Date.now(),
          checksums: "{}",
          http_metadata: uploadRow.http_metadata,
          custom_metadata: uploadRow.custom_metadata,
        };
        putRow(newRow);
        for (const part of parts) {
          sql.exec(
            // Link parts with the object
            "UPDATE _mf_multipart_parts SET object_key = ?3 WHERE upload_id = ?1 AND part_number = ?2",
            uploadId,
            part.part_number,
            key,
          );
        }

        // 7. Delete unlinked, unused parts
        const partRows = sql
          .exec<Pick<MultipartPartRow, "blob_id">>(
            "DELETE FROM _mf_multipart_parts WHERE upload_id = ?1 AND object_key IS NULL RETURNING blob_id",
            uploadId,
          )
          .toArray();
        for (const partRow of partRows) oldBlobIds.push(partRow.blob_id);

        // 8. Mark the upload as completed
        updateUploadState(uploadId, MultipartUploadState.COMPLETED);

        return { newRow, oldBlobIds };
      }),
    abortMultipartUpload: (key: string, uploadId: string) =>
      storage.transactionSync(() => {
        // 1. Make sure this multipart upload exists, ignoring finalised states
        const uploadRow = getUploadState(uploadId, key);
        if (uploadRow === undefined) {
          throw new InternalError();
        } else if (uploadRow.state > MultipartUploadState.IN_PROGRESS) {
          // If this upload has already been finalised, return here. `abort()`
          // can be called multiple times, and on already `complete()`ed
          // uploads. In the later case, we really don't want to delete
          // pointed-to parts.
          return [];
        }

        // 2. Delete all parts in the upload
        const partRows = sql
          .exec<Pick<MultipartPartRow, "blob_id">>(
            "DELETE FROM _mf_multipart_parts WHERE upload_id = ?1 RETURNING blob_id",
            uploadId,
          )
          .toArray();
        const oldBlobIds = partRows.map(({ blob_id }) => blob_id);

        // 3. Mark the uploaded as aborted
        updateUploadState(uploadId, MultipartUploadState.ABORTED);

        return oldBlobIds;
      }),
  };
}

interface ControlOp {
  name: string;
  args?: Array<unknown>;
}

export class R2BucketObject implements DurableObject {
  readonly timers = new Timers();
  // If this Durable Object receives a control op, assume it's being tested.
  // Used to adjust the minimum multipart part size in tests.
  beingTested = false;

  readonly #stmts: ReturnType<typeof sqlStmts>;

  #name?: string;
  #blob?: BlobStore;

  // Multipart uploads are stored as multiple blobs. Therefore, when reading a
  // multipart upload, we'll be reading multiple blobs. When an object is
  // deleted, all its blobs are deleted in the background.
  //
  // Normally for single part objects, this is fine, since we'd open a handle
  // to a single blob, which we'd have until we closed it, at which point the
  // blob may be deleted. With multipart, we don't want to open handles for all
  // blobs as we could hit open file descriptor limits. Similarly, we don't
  // want to read all blobs first, as we'd have to buffer them.
  //
  // Instead, we set up in-process locking on blobs needed for multipart reads.
  // When we start a multipart read, we acquire all the blobs we need, then
  // release them as we've streamed each part. Multiple multipart reads may be
  // in-progress at any given time, so we use a wait group.
  //
  // This assumes we only ever have a single runtime instance operating on a
  // blob store, which is usually true for on-disk stores. If we really wanted
  // to do this properly, we could store the bookkeeping for the wait group in
  // SQLite, but then we'd have to implement some inter-process
  // signalling/subscription system.
  readonly #inUseBlobs = new Map<BlobId, WaitGroup>();

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {
    state.storage.sql.exec("PRAGMA case_sensitive_like = TRUE");
    state.storage.sql.exec(SQL_SCHEMA);
    this.#stmts = sqlStmts(state.storage);
  }

  get name(): string {
    // `name` is initialised from the bucket header on first request
    assert(
      this.#name !== undefined,
      "Expected `R2BucketObject#fetch()` call before `name` access",
    );
    return this.#name;
  }

  get blob(): BlobStore {
    return (this.#blob ??= new BlobStore(
      this.env[BINDING_R2_BLOBS],
      this.name,
    ));
  }

  async fetch(req: Request): Promise<Response> {
    // Each request includes the bucket name, so the `BlobStore` can be
    // namespaced by it (mirrors Miniflare's persistence format, which
    // namespaces blobs by name rather than Durable Object ID).
    const encodedName = req.headers.get(HEADER_R2_BUCKET);
    assert(encodedName !== null, `Expected ${HEADER_R2_BUCKET} header`);
    this.#name = decodeURIComponent(encodedName);

    // Allow control of object internals via a reserved header. Used by tests
    // to update fake time and access internal storage.
    if (this.env[BINDING_R2_ENABLE_CONTROL_ENDPOINTS] === true) {
      const controlOpHeader = req.headers.get(HEADER_R2_CONTROL_OP);
      if (controlOpHeader !== null) {
        const controlOp = (await req.json()) as ControlOp;
        return this.#handleControlOp(controlOp);
      }
    }

    try {
      if (req.method === "GET") return await this.#handleGet(req);
      if (req.method === "PUT") return await this.#handlePut(req);
      return new Response(null, { status: 405 });
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse();
      const error = e instanceof Error ? e : new Error(String(e));
      const fallback = error.stack ?? error.message;
      console.error(fallback);
      return new Response(fallback, { status: 500 });
    } finally {
      // Make sure the request body is consumed. Otherwise, calls which make
      // requests to this object may hang and never resolve.
      // See https://github.com/cloudflare/workerd/issues/960.
      if (req.body !== null && !req.bodyUsed) {
        await req.body.pipeTo(new WritableStream());
      }
    }
  }

  async #handleControlOp({ name, args = [] }: ControlOp): Promise<Response> {
    this.beingTested = true;
    if (name === "sqlQuery") {
      // Run an arbitrary SQL query (e.g. get the blob ID for a key)
      const [query, ...params] = args;
      assert(typeof query === "string");
      const results = this.state.storage.sql
        .exec(query, ...(params as Array<SqlStorageValue>))
        .toArray();
      return Response.json(results);
    } else if (name === "getBlob") {
      // Get an arbitrary blob
      const [id] = args;
      assert(typeof id === "string");
      const stream = await this.blob.get(id);
      return new Response(stream, { status: stream === null ? 404 : 200 });
    } else {
      // Enable/disable fake timers, advance time, or wait for tasks
      const func: unknown = this.timers[name as keyof Timers];
      assert(typeof func === "function", `Unknown control op: ${name}`);
      const result = await (func as (...args: Array<unknown>) => unknown).apply(
        this.timers,
        args,
      );
      return Response.json(result ?? null);
    }
  }

  #acquireBlob(blobId: BlobId) {
    let waitGroup = this.#inUseBlobs.get(blobId);
    if (waitGroup === undefined) {
      waitGroup = new WaitGroup();
      this.#inUseBlobs.set(blobId, waitGroup);
      waitGroup.add();
      // Automatically remove the wait group once this blob is fully released
      void waitGroup.wait().then(() => this.#inUseBlobs.delete(blobId));
    } else {
      waitGroup.add();
    }
  }

  #releaseBlob(blobId: BlobId) {
    this.#inUseBlobs.get(blobId)?.done();
  }

  #backgroundDelete(blobId: BlobId) {
    this.timers.queueMicrotask(async () => {
      // Wait for all multipart gets using this blob to complete
      await this.#inUseBlobs.get(blobId)?.wait();
      return this.blob.delete(blobId).catch((e) => {
        console.error("R2BucketObject##backgroundDelete():", e);
      });
    });
  }

  #assembleMultipartValue(
    parts: Array<Pick<MultipartPartRow, "blob_id" | "size">>,
    queryRange: InclusiveRange,
  ): ReadableStream<Uint8Array> {
    // Find required parts (and the ranges within them) to satisfy the query
    // (doing this outside async IIFE to acquire all required parts before we
    // start streaming any)
    const requiredParts: Array<{ blobId: BlobId; range: InclusiveRange }> = [];
    let start = 0;
    for (const part of parts) {
      const partRange: InclusiveRange = { start, end: start + part.size - 1 };
      if (rangeOverlaps(partRange, queryRange)) {
        const range: InclusiveRange = {
          start: Math.max(partRange.start, queryRange.start) - partRange.start,
          end: Math.min(partRange.end, queryRange.end) - partRange.start,
        };
        this.#acquireBlob(part.blob_id);
        requiredParts.push({ blobId: part.blob_id, range });
      }
      start = partRange.end + 1;
    }

    // Stream required parts, the `Promise`s returned from `pipeTo()` won't
    // resolve until a reader starts reading, so run this in the background as
    // an async IIFE.
    //
    // NOTE: we can't use `IdentityTransformStream` here as piping the readable
    // side of an `IdentityTransformStream` to the writable side of another
    // `IdentityTransformStream` is not supported:
    // https://github.com/cloudflare/workerd/blob/c6f439ca37c5fa34acc54a6df79214ae029ddf9f/src/workerd/api/streams/internal.c%2B%2B#L169
    // We'll be piping to an `IdentityTransformStream` when we encode the
    // metadata followed by this stream as the response body.
    const identity = new TransformStream<Uint8Array, Uint8Array>();
    void (async () => {
      let i = 0;
      try {
        // Sharing loop index with `finally` block to ensure all blobs
        // released. `i++` is only called at the *end* of a loop iteration,
        // just after we release a blob. If an iteration throws, `i` will
        // remain the same, and that blob (and the rest) will be released in
        // the `finally`.
        for (; i < requiredParts.length; i++) {
          const { blobId, range } = requiredParts[i];
          const value = await this.blob.get(blobId, range);
          const msg = `Expected to find blob "${blobId}" for multipart value`;
          assert(value !== null, msg);
          await value.pipeTo(identity.writable, { preventClose: true });
          this.#releaseBlob(blobId);
        }
        await identity.writable.close();
      } catch (e) {
        await identity.writable.abort(e);
      } finally {
        for (; i < requiredParts.length; i++) {
          this.#releaseBlob(requiredParts[i].blobId);
        }
      }
    })();
    return identity.readable;
  }

  async #head(key: string): Promise<InternalR2Object> {
    validate.key(key);

    const row = this.#stmts.getByKey(key);
    if (row === undefined) throw new NoSuchKey();

    const range: R2Range = { offset: 0, length: row.size };
    return new InternalR2Object(row, range);
  }

  async #get(
    key: string,
    opts: InternalR2GetOptions,
  ): Promise<InternalR2ObjectBody | InternalR2Object> {
    validate.key(key);

    // Try to get this key, including multipart parts if it's multipart
    const result = this.#stmts.getPartsByKey(key);
    if (result === undefined) throw new NoSuchKey();
    const { row, parts } = result;

    // Validate pre-condition
    const defaultR2Range: R2Range = { offset: 0, length: row.size };
    try {
      validate.condition(row, opts.onlyIf);
    } catch (e) {
      if (e instanceof PreconditionFailed) {
        e.attach(new InternalR2Object(row, defaultR2Range));
      }
      throw e;
    }

    // Validate range, and convert to R2 range for return
    const range = validate.range(opts, row.size);
    let r2Range: R2Range;
    if (range === undefined) {
      r2Range = defaultR2Range;
    } else {
      const start = range.start;
      const end = Math.min(range.end, row.size);
      r2Range = { offset: start, length: end - start + 1 };
    }

    let value: ReadableStream<Uint8Array> | null;
    if (row.blob_id === null) {
      // If this is a multipart object, we should've fetched multipart parts
      assert(parts !== undefined);
      const defaultRange = { start: 0, end: row.size - 1 };
      value = this.#assembleMultipartValue(parts, range ?? defaultRange);
    } else {
      // Otherwise, just return a single part value
      value = await this.blob.get(row.blob_id, range);
      if (value === null) throw new NoSuchKey();
    }

    return new InternalR2ObjectBody(row, value, r2Range);
  }

  async #put(
    key: string,
    value: ReadableStream<Uint8Array>,
    valueSize: number,
    opts: InternalR2PutOptions,
  ): Promise<InternalR2Object> {
    // Store value in the blob store, computing required digests as we go
    // (this means we don't have to buffer the entire stream to compute them)
    const algorithms: Array<DigestAlgorithm> = [];
    for (const { name, field } of R2_HASH_ALGORITHMS) {
      // Always compute MD5 digest
      if (field === "md5" || opts[field] !== undefined) algorithms.push(name);
    }
    const digesting = new DigestingStream(algorithms);
    const blobId = await this.blob.put(value.pipeThrough(digesting));
    const digests = await digesting.digests;
    const md5Digest = digests.get("MD5");
    assert(md5Digest !== undefined);
    const md5DigestHex = hexEncode(md5Digest);

    const checksums = validate
      .key(key)
      .size(valueSize)
      .metadataSize(opts.customMetadata)
      .hash(digests, opts);
    const row: ObjectRow = {
      key,
      blob_id: blobId,
      version: generateVersion(),
      size: valueSize,
      etag: md5DigestHex,
      uploaded: Date.now(),
      checksums: JSON.stringify(checksums),
      http_metadata: JSON.stringify(opts.httpMetadata ?? {}),
      custom_metadata: JSON.stringify(opts.customMetadata ?? {}),
    };
    let oldBlobIds: Array<string> | undefined;
    try {
      oldBlobIds = this.#stmts.put(row, opts.onlyIf);
    } catch (e) {
      // Probably precondition failed. In any case, the put transaction failed,
      // so we're not storing a reference to the blob ID
      this.#backgroundDelete(blobId);
      throw e;
    }
    if (oldBlobIds !== undefined) {
      for (const blobId of oldBlobIds) this.#backgroundDelete(blobId);
    }
    return new InternalR2Object(row);
  }

  #delete(keys: string | Array<string>) {
    if (!Array.isArray(keys)) keys = [keys];
    for (const key of keys) validate.key(key);
    const oldBlobIds = this.#stmts.deleteByKeys(keys);
    for (const blobId of oldBlobIds) this.#backgroundDelete(blobId);
  }

  #listWithoutDelimiterQuery(excludeHttp: boolean, excludeCustom: boolean) {
    if (excludeHttp && excludeCustom) return this.#stmts.listWithoutDelimiter;
    if (excludeHttp) return this.#stmts.listCustomMetadataWithoutDelimiter;
    if (excludeCustom) return this.#stmts.listHttpMetadataWithoutDelimiter;
    return this.#stmts.listHttpCustomMetadataWithoutDelimiter;
  }

  async #list(opts: InternalR2ListOptions): Promise<InternalR2Objects> {
    const prefix = opts.prefix ?? "";

    let limit = opts.limit ?? R2Limits.MAX_LIST_KEYS;
    validate.limit(limit);

    // If metadata is requested, R2 may return fewer than `limit` results to
    // accommodate it. Simulate this by limiting the limit to 100.
    // See https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions.
    const include = opts.include ?? [];
    if (include.length > 0) limit = Math.min(limit, 100);
    const excludeHttp = !include.includes("httpMetadata");
    const excludeCustom = !include.includes("customMetadata");
    const rowObject = (
      row: Omit<ObjectRow, "blob_id" | "http_metadata" | "custom_metadata"> & {
        http_metadata?: string;
        custom_metadata?: string;
      },
    ) => {
      if (row.http_metadata === undefined || excludeHttp) {
        row.http_metadata = "{}";
      }
      if (row.custom_metadata === undefined || excludeCustom) {
        row.custom_metadata = "{}";
      }
      return new InternalR2Object(row as Omit<ObjectRow, "blob_id">);
    };

    // If cursor set, and lexicographically after `startAfter`, use that for
    // `startAfter` instead
    let startAfter = opts.startAfter;
    if (opts.cursor !== undefined) {
      const cursorStartAfter = base64Decode(opts.cursor);
      if (startAfter === undefined || cursorStartAfter > startAfter) {
        startAfter = cursorStartAfter;
      }
    }

    let delimiter = opts.delimiter;
    if (delimiter === "") delimiter = undefined;

    // Run appropriate query depending on options
    const params = {
      prefix,
      start_after: startAfter ?? null,
      // Increase the queried limit by 1, if we return this many results, we
      // know there are more rows. We'll truncate to the original limit before
      // returning results.
      limit: limit + 1,
    };

    let objects: Array<InternalR2Object>;
    const delimitedPrefixes: Array<string> = [];
    let nextCursorStartAfter: string | undefined;

    if (delimiter !== undefined) {
      const rows = this.#stmts.listMetadata({ ...params, delimiter });

      // If there are more results, we'll be returning a cursor
      const hasMoreRows = rows.length === limit + 1;
      rows.splice(limit, 1);

      objects = [];
      for (const row of rows) {
        if (row.delimited_prefix_or_key.startsWith("dlp:")) {
          delimitedPrefixes.push(row.delimited_prefix_or_key.substring(4));
        } else {
          objects.push(rowObject({ ...row, key: row.last_key }));
        }
      }

      if (hasMoreRows) nextCursorStartAfter = rows[limit - 1].last_key;
    } else {
      // If we don't have a delimiter, we can use a more efficient query
      const query = this.#listWithoutDelimiterQuery(excludeHttp, excludeCustom);
      const rows = query(params);

      // If there are more results, we'll be returning a cursor
      const hasMoreRows = rows.length === limit + 1;
      rows.splice(limit, 1);

      objects = rows.map(rowObject);

      if (hasMoreRows) nextCursorStartAfter = rows[limit - 1].key;
    }

    // The cursor encodes a key to start after rather than the key to start at
    // to ensure keys added between `list()` calls are returned.
    const nextCursor = maybeApply(base64Encode, nextCursorStartAfter);

    return {
      objects,
      truncated: nextCursor !== undefined,
      cursor: nextCursor,
      delimitedPrefixes,
    };
  }

  async #createMultipartUpload(
    key: string,
    opts: InternalR2CreateMultipartUploadOptions,
  ): Promise<R2CreateMultipartUploadResponse> {
    validate.key(key);

    const uploadId = generateId();
    this.#stmts.createMultipartUpload({
      key,
      upload_id: uploadId,
      http_metadata: JSON.stringify(opts.httpMetadata ?? {}),
      custom_metadata: JSON.stringify(opts.customMetadata ?? {}),
    });
    return { uploadId };
  }

  async #uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    value: ReadableStream<Uint8Array>,
    valueSize: number,
  ): Promise<R2UploadPartResponse> {
    validate.key(key);

    // Store value in the blob store, computing MD5 digest as we go
    const digesting = new DigestingStream(["MD5"]);
    const blobId = await this.blob.put(value.pipeThrough(digesting));
    const digests = await digesting.digests;
    const md5Digest = digests.get("MD5");
    assert(md5Digest !== undefined);

    // Generate random ETag for this part
    const etag = generateId();

    // Store the new part in the metadata store, removing the old blob
    // associated with this part number if any
    let maybeOldBlobId: string | undefined;
    try {
      maybeOldBlobId = this.#stmts.putPart(key, {
        upload_id: uploadId,
        part_number: partNumber,
        blob_id: blobId,
        size: valueSize,
        etag,
        checksum_md5: hexEncode(md5Digest),
      });
    } catch (e) {
      // Probably upload not found. In any case, the put transaction failed,
      // so we're not storing a reference to the blob ID
      this.#backgroundDelete(blobId);
      throw e;
    }
    if (maybeOldBlobId !== undefined) this.#backgroundDelete(maybeOldBlobId);

    return { etag };
  }

  async #completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<R2PublishedPart>,
  ): Promise<InternalR2Object> {
    validate.key(key);
    const minPartSize = this.beingTested
      ? R2Limits.MIN_MULTIPART_PART_SIZE_TEST
      : R2Limits.MIN_MULTIPART_PART_SIZE;
    const { newRow, oldBlobIds } = this.#stmts.completeMultipartUpload(
      key,
      uploadId,
      parts,
      minPartSize,
    );
    for (const blobId of oldBlobIds) this.#backgroundDelete(blobId);
    return new InternalR2Object(newRow);
  }

  async #abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    validate.key(key);
    const oldBlobIds = this.#stmts.abortMultipartUpload(key, uploadId);
    for (const blobId of oldBlobIds) this.#backgroundDelete(blobId);
  }

  async #handleGet(req: Request): Promise<Response> {
    const metadata = decodeHeaderMetadata(req);

    let result: InternalR2Object | InternalR2ObjectBody | InternalR2Objects;
    if (metadata.method === "head") {
      result = await this.#head(metadata.object);
    } else if (metadata.method === "get") {
      result = await this.#get(metadata.object, metadata);
    } else if (metadata.method === "list") {
      result = await this.#list(metadata);
    } else {
      throw new InternalError();
    }

    return encodeResult(result);
  }

  async #handlePut(req: Request): Promise<Response> {
    const { metadata, metadataSize, value } = await decodeMetadata(req);

    if (metadata.method === "delete") {
      this.#delete("object" in metadata ? metadata.object : metadata.objects);
      return new Response();
    } else if (metadata.method === "put") {
      const contentLength = parseInt(
        req.headers.get("Content-Length") ?? "NaN",
      );
      // `workerd` requires a known value size for R2 put requests:
      // - https://github.com/cloudflare/workerd/blob/e3479895a2ace28e4fd5f1399cea4c92291966ab/src/workerd/api/r2-rpc.c%2B%2B#L154-L156
      // - https://github.com/cloudflare/workerd/blob/e3479895a2ace28e4fd5f1399cea4c92291966ab/src/workerd/api/r2-rpc.c%2B%2B#L188-L189
      assert(!isNaN(contentLength));
      const valueSize = contentLength - metadataSize;
      const result = await this.#put(
        metadata.object,
        value,
        valueSize,
        metadata,
      );
      return encodeResult(result);
    } else if (metadata.method === "createMultipartUpload") {
      const result = await this.#createMultipartUpload(
        metadata.object,
        metadata,
      );
      return encodeJSONResult(result);
    } else if (metadata.method === "uploadPart") {
      const contentLength = parseInt(
        req.headers.get("Content-Length") ?? "NaN",
      );
      // `workerd` requires a known value size for R2 put requests as above
      assert(!isNaN(contentLength));
      const valueSize = contentLength - metadataSize;
      const result = await this.#uploadPart(
        metadata.object,
        metadata.uploadId,
        metadata.partNumber,
        value,
        valueSize,
      );
      return encodeJSONResult(result);
    } else if (metadata.method === "completeMultipartUpload") {
      const result = await this.#completeMultipartUpload(
        metadata.object,
        metadata.uploadId,
        metadata.parts,
      );
      return encodeResult(result);
    } else if (metadata.method === "abortMultipartUpload") {
      await this.#abortMultipartUpload(metadata.object, metadata.uploadId);
      return new Response();
    } else {
      throw new InternalError(); // Unknown method: should never be reached
    }
  }
}
