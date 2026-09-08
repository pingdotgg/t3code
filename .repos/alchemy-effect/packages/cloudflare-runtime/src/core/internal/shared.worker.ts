// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Utilities shared between the internal workers that simulate bindings
 * locally (KV, R2, Queues, ...), adapted from Miniflare's
 * `workers-sdk/packages/miniflare/src/workers/shared/*`.
 *
 * Not a worker itself: the `.worker.ts` suffix ensures this module is
 * type-checked against `@cloudflare/workers-types` (it is excluded from the
 * worker entry points in `tsdown.config.ts`, and bundled into the workers
 * that import it).
 */

export function assert(
  condition: unknown,
  message?: string,
): asserts condition {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

export class HttpError extends Error {
  constructor(
    readonly code: number,
    message?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = `${new.target.name} [${code}]`;
  }

  toResponse(): Response {
    return new Response(this.message, {
      status: this.code,
      // Custom statusMessage is required for runtime error messages
      statusText: this.message.substring(0, 512),
    });
  }
}

export type Awaitable<T> = T | Promise<T>;

export function maybeApply<From, To>(
  f: (value: From) => To,
  maybeValue: From | undefined,
): To | undefined {
  return maybeValue === undefined ? undefined : f(maybeValue);
}

/**
 * Real/fake clock. Tests enable fake time via control operations to exercise
 * time-dependent behaviour (e.g. expiration) without waiting, and to
 * deterministically await background blob deletions (`waitForFakeTasks`).
 */
export class Timers {
  /** Fake unix time in milliseconds. If defined, fake timers are enabled. */
  #fakeTimestamp?: number;
  #fakeRunningTasks = new Set<Promise<unknown>>();

  now = () => this.#fakeTimestamp ?? Date.now();

  queueMicrotask(closure: () => Awaitable<unknown>): void {
    if (this.#fakeTimestamp === undefined)
      return queueMicrotask(() => void closure());
    const result = closure();
    if (result instanceof Promise) {
      this.#fakeRunningTasks.add(result);
      result.finally(() => this.#fakeRunningTasks.delete(result));
    }
  }

  enableFakeTimers(timestamp: number) {
    this.#fakeTimestamp = timestamp;
  }
  disableFakeTimers() {
    this.#fakeTimestamp = undefined;
  }
  advanceFakeTime(delta: number) {
    assert(
      this.#fakeTimestamp !== undefined,
      "Expected fake timers to be enabled before `advanceFakeTime()` call",
    );
    this.#fakeTimestamp += delta;
  }
  async waitForFakeTasks() {
    while (this.#fakeRunningTasks.size > 0) {
      await Promise.all(this.#fakeRunningTasks);
    }
  }
}

export function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(encoded: string): string {
  return new TextDecoder().decode(base64DecodeBytes(encoded));
}

export function base64DecodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/*! Path sanitisation regexps adapted from node-sanitize-filename:
 * https://github.com/parshap/node-sanitize-filename/blob/209c39b914c8eb48ee27bcbde64b2c7822fdf3de/index.js#L4-L37
 * Licensed under the ISC license (Copyright Parsha Pourkhomami).
 */
const dotRegexp = /(^|\/|\\)(\.+)(\/|\\|$)/g;
// oxlint-disable-next-line no-control-regex
const illegalRegexp = /[?<>*"'^/\\:|\x00-\x1f\x80-\x9f]/g;
const windowsReservedRegexp = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const leadingRegexp = /^[ /\\]+/;
const trailingRegexp = /[ /\\]+$/;

function dotReplacement(_match: string, g1: string, g2: string, g3: string) {
  return `${g1}${"".padStart(g2.length, "_")}${g3}`;
}
function underscoreReplacement(match: string) {
  return "".padStart(match.length, "_");
}
function sanitisePath(unsafe: string): string {
  return unsafe
    .replace(dotRegexp, dotReplacement)
    .replace(dotRegexp, dotReplacement)
    .replace(illegalRegexp, "_")
    .replace(windowsReservedRegexp, "_")
    .replace(leadingRegexp, underscoreReplacement)
    .replace(trailingRegexp, underscoreReplacement)
    .substring(0, 255);
}

export interface InclusiveRange {
  start: number; // inclusive
  end: number; // inclusive
}

// Matches case-insensitive string "bytes", ignoring surrounding whitespace,
// followed by "=" (example matches: "bytes=...", "ByTeS=...", "   bytes  =...")
const rangePrefixRegexp = /^ *bytes *=/i;

// Matches single range, with optional start/end numbers, ignoring whitespace
// (example matches: "1-2", "1-", "2-", "  1   -    2   ", "  -  " [note this
// last case is invalid and will be handled separately in `parseRanges`])
const rangeRegexp = /^ *(?<start>\d+)? *- *(?<end>\d+)? *$/;
interface RangeRegexpGroups {
  start?: string;
  end?: string;
}

/**
 * Parses an HTTP `Range` header (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Range),
 * returning either:
 * - `undefined` indicating the range is unsatisfiable
 * - An empty array indicating the entire response should be returned
 * - A non-empty array of inclusive ranges of the response to return
 */
export function parseRanges(
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
    const { start, end } = match.groups as RangeRegexpGroups;
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

/** Serialisable, opaque, unguessable blob identifier. */
export type BlobId = string;

function generateBlobId(): BlobId {
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes.subarray(0, 32));
  const timestamp = BigInt(
    Math.floor(performance.timeOrigin + performance.now()),
  );
  new DataView(bytes.buffer).setBigInt64(32, timestamp);
  return hexEncode(bytes);
}

export interface MultipartOptions {
  contentType?: string;
}
export interface MultipartReadableStream {
  multipartContentType: string;
  body: ReadableStream<Uint8Array>;
}

const ENCODER = new TextEncoder();

function rangeHeaders(range: InclusiveRange) {
  return { Range: `bytes=${range.start}-${range.end}` };
}

function assertFullRangeRequest(range: InclusiveRange, contentLength: number) {
  assert(
    range.start === 0 && range.end === contentLength - 1,
    "Received full content, but requested partial content",
  );
}

async function writeMultipleRanges(
  fetcher: Fetcher,
  url: URL,
  ranges: Array<InclusiveRange>,
  boundary: string,
  writable: WritableStream,
  contentLength: number,
  contentType?: string,
): Promise<void> {
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const writer = writable.getWriter();
    // If this isn't the first thing we've written, we'll need to prepend CRLF
    if (i > 0) await writer.write(ENCODER.encode("\r\n"));
    // Write boundary and headers
    await writer.write(ENCODER.encode(`--${boundary}\r\n`));
    if (contentType !== undefined) {
      await writer.write(ENCODER.encode(`Content-Type: ${contentType}\r\n`));
    }
    const start = range.start;
    const end = Math.min(range.end, contentLength - 1);
    await writer.write(
      ENCODER.encode(
        `Content-Range: bytes ${start}-${end}/${contentLength}\r\n\r\n`,
      ),
    );
    writer.releaseLock();
    // Fetch and write the range
    const res = await fetcher.fetch(url, { headers: rangeHeaders(range) });
    assert(
      res.ok && res.body !== null,
      `Failed to fetch ${url}[${range.start},${range.end}], received ${res.status} ${res.statusText}`,
    );
    // If we specified a range, but received full content, make sure the range
    // covered the full content
    if (res.status !== 206) assertFullRangeRequest(range, contentLength);
    await res.body.pipeTo(writable, { preventClose: true });
  }
  // Finished writing all ranges, now write the trailer
  const writer = writable.getWriter();
  if (ranges.length > 0) await writer.write(ENCODER.encode("\r\n"));
  await writer.write(ENCODER.encode(`--${boundary}--`));
  await writer.close();
}

/**
 * Store for binary large objects, backed by a disk service. Blobs have
 * unguessable identifiers, can be deleted, but are otherwise immutable, which
 * makes atomic updates with a SQLite metadata store possible: a blob is
 * unreachable until its id is committed to the metadata store, and dangling
 * blobs (e.g. after a failed insert) are simply garbage-collected. Reads may
 * be single- or multi-ranged (as `multipart/byteranges`), so e.g. R2
 * multipart gets only stream the parts covering the requested range.
 */
export class BlobStore {
  readonly #fetcher: Fetcher;
  readonly #baseURL: string;

  constructor(fetcher: Fetcher, namespace: string) {
    // `baseURL`'s pathname is relative to the disk service's root, so blobs
    // for namespace `ns` live in `{persistPath}/ns/blobs/`.
    this.#fetcher = fetcher;
    this.#baseURL = `http://placeholder/${encodeURIComponent(sanitisePath(namespace))}/blobs/`;
  }

  #idURL(id: BlobId): URL | null {
    const url = new URL(this.#baseURL + id);
    return url.toString().startsWith(this.#baseURL) ? url : null;
  }

  get(
    id: BlobId,
    range?: InclusiveRange,
  ): Promise<ReadableStream<Uint8Array> | null>;
  get(
    id: BlobId,
    ranges: Array<InclusiveRange>,
    opts?: MultipartOptions,
  ): Promise<MultipartReadableStream | null>;
  async get(
    id: BlobId,
    range?: InclusiveRange | Array<InclusiveRange>,
    opts?: MultipartOptions,
  ): Promise<ReadableStream<Uint8Array> | MultipartReadableStream | null> {
    const idURL = this.#idURL(id);
    if (idURL === null) return null;
    if (Array.isArray(range))
      return this.#getMultipleRanges(idURL, range, opts);
    return this.#getSingleRange(idURL, range);
  }

  async #getSingleRange(
    idURL: URL,
    range?: InclusiveRange,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const headers: HeadersInit = range === undefined ? {} : rangeHeaders(range);
    const res = await this.#fetcher.fetch(idURL, { headers });
    if (res.status === 404) return null;
    assert(res.ok && res.body !== null);
    if (range !== undefined && res.status !== 206) {
      // If we specified a range, but received full content, make sure the
      // range covered the full content
      const contentLength = parseInt(
        res.headers.get("Content-Length") ?? "NaN",
      );
      assert(!Number.isNaN(contentLength));
      assertFullRangeRequest(range, contentLength);
    }
    return res.body;
  }

  async #getMultipleRanges(
    idURL: URL,
    ranges: Array<InclusiveRange>,
    opts?: MultipartOptions,
  ): Promise<MultipartReadableStream | null> {
    // Check resource exists, and get content length
    const res = await this.#fetcher.fetch(idURL, { method: "HEAD" });
    if (res.status === 404) return null;
    assert(res.ok);

    const contentLength = parseInt(res.headers.get("Content-Length") ?? "NaN");
    assert(!Number.isNaN(contentLength));

    // See https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests#multipart_ranges
    // for details on `multipart/byteranges` responses
    const boundary = `cloudflare-runtime-boundary-${crypto.randomUUID()}`;
    const multipartContentType = `multipart/byteranges; boundary=${boundary}`;
    const { readable, writable } = new IdentityTransformStream();
    void writeMultipleRanges(
      this.#fetcher,
      idURL,
      ranges,
      boundary,
      writable,
      contentLength,
      opts?.contentType,
    ).catch((e) => console.error("Error writing multipart stream:", e));
    return { multipartContentType, body: readable };
  }

  async put(stream: ReadableStream<Uint8Array>): Promise<BlobId> {
    const id = generateBlobId();
    // Blob IDs are hex, so this should never be `null`
    const idURL = this.#idURL(id);
    assert(idURL !== null);
    await this.#fetcher.fetch(idURL, { method: "PUT", body: stream });
    return id;
  }

  async delete(id: BlobId): Promise<void> {
    // Ignore if outside root or not found
    const idURL = this.#idURL(id);
    if (idURL === null) return;
    const res = await this.#fetcher.fetch(idURL, { method: "DELETE" });
    assert(res.ok || res.status === 404);
  }
}

// -----------------------------------------------------------------------------
// Key/value storage (`workers/shared/keyvalue.worker.ts`)
// -----------------------------------------------------------------------------

export interface KeyEntry<Metadata = unknown> {
  key: string;
  /** Milliseconds since unix epoch. */
  expiration?: number;
  metadata?: Metadata;
}
export interface KeyValueEntry<Metadata = unknown> extends KeyEntry<Metadata> {
  value: ReadableStream<Uint8Array>;
}
export interface KeyMultipartValueEntry<
  Metadata = unknown,
> extends KeyEntry<Metadata> {
  value: MultipartReadableStream;
}
export interface KeyEntriesQuery {
  prefix?: string;
  cursor?: string;
  limit: number;
}
export interface KeyEntries<Metadata = unknown> {
  keys: Array<KeyEntry<Metadata>>;
  cursor?: string;
}

type Row = {
  key: string;
  blob_id: BlobId;
  /** Milliseconds since unix epoch, or `NULL`. */
  expiration: number | null;
  /** JSON, or `NULL`. */
  metadata: string | null;
};

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS _mf_entries (
  key TEXT PRIMARY KEY,
  blob_id TEXT NOT NULL,
  expiration INTEGER,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS _mf_entries_expiration_idx ON _mf_entries(expiration);
`;

function rowEntry<Metadata>(entry: Omit<Row, "blob_id">): KeyEntry<Metadata> {
  return {
    key: entry.key,
    expiration: entry.expiration ?? undefined,
    metadata: entry.metadata === null ? undefined : JSON.parse(entry.metadata),
  };
}

export type KeyValueRangesFactory<Metadata> = (
  metadata: Metadata,
) => { ranges?: Array<InclusiveRange> } & MultipartOptions;

/**
 * SQLite-metadata + blob-store key/value storage shared by the KV and Cache
 * simulators. Values live in a `BlobStore`; the `_mf_entries` table maps keys
 * to blob ids, expirations and JSON metadata.
 */
export class KeyValueStorage<Metadata = unknown> {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  readonly #blob: BlobStore;
  readonly #timers: Timers;

  constructor(storage: DurableObjectStorage, blob: BlobStore, timers: Timers) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#sql.exec("PRAGMA case_sensitive_like = TRUE");
    this.#sql.exec(SQL_SCHEMA);
    this.#blob = blob;
    this.#timers = timers;
  }

  #hasExpired(entry: Pick<Row, "expiration">) {
    return entry.expiration !== null && entry.expiration <= this.#timers.now();
  }

  #backgroundDelete(blobId: BlobId) {
    // Once rows are deleted, or if they failed to insert, delete the
    // corresponding blobs in the background, ignoring errors. Blob IDs are
    // unguessable, so a blob without references can't be accessed: failed
    // deletes just leave a dangling file taking up disk space.
    this.#timers.queueMicrotask(() =>
      this.#blob.delete(blobId).catch(() => {}),
    );
  }

  get(key: string): Promise<KeyValueEntry<Metadata> | null>;
  get(
    key: string,
    optsFactory?: KeyValueRangesFactory<Metadata>,
  ): Promise<KeyMultipartValueEntry<Metadata> | null>;
  async get(
    key: string,
    optsFactory?: KeyValueRangesFactory<Metadata>,
  ): Promise<
    KeyValueEntry<Metadata> | KeyMultipartValueEntry<Metadata> | null
  > {
    // Try to get key from metadata store, returning null if not found
    const row = this.#sql
      .exec<Row>(
        "SELECT key, blob_id, expiration, metadata FROM _mf_entries WHERE key = ?1",
        key,
      )
      .toArray()
      .at(0);
    if (row === undefined) return null;

    if (this.#hasExpired(row)) {
      // If expired, delete from metadata and blob stores. Assuming a
      // monotonically increasing clock, this doesn't need to be in a
      // transaction with the above get: on a repeated `get()` the entry will
      // still be expired, deleting an already deleted row does nothing, and
      // the blob-not-found error is ignored.
      this.#sql.exec("DELETE FROM _mf_entries WHERE key = ?1", key).toArray();
      this.#backgroundDelete(row.blob_id);
      return null;
    }

    // Return the blob as a stream
    const entry = rowEntry<Metadata>(row);
    const opts = entry.metadata && optsFactory?.(entry.metadata);
    if (!opts || opts.ranges === undefined || opts.ranges.length <= 1) {
      // If no range was requested, or just a single one was, return a regular
      // stream
      const value = await this.#blob.get(
        row.blob_id,
        opts ? opts.ranges?.[0] : undefined,
      );
      if (value === null) return null;
      return { ...entry, value };
    } else {
      // Otherwise, if multiple ranges were requested, return a multipart stream
      const value = await this.#blob.get(row.blob_id, opts.ranges, opts);
      if (value === null) return null;
      return { ...entry, value };
    }
  }

  async put(
    entry: KeyValueEntry<Awaitable<Metadata>> & { signal?: AbortSignal },
  ): Promise<void> {
    // (`Awaitable` allows metadata to be a `Promise`; the Cache simulator uses
    // this to include `size` in the metadata, which may only be known once
    // the stream is written to the blob store if no `Content-Length` header
    // was specified)

    // Empty keys are not permitted because listing defaults to starting after
    // "". See `list()` for more details.
    assert(entry.key !== "");

    // Write the value to the blob store. Note the put isn't aborted until
    // after it's fully completed. This ensures "too large" error messages
    // that measure the length of the stream using a `TransformStream` see the
    // full value, and can include the correct number of bytes in the message.
    const blobId = await this.#blob.put(entry.value);
    if (entry.signal?.aborted) {
      this.#backgroundDelete(blobId);
      entry.signal.throwIfAborted();
    }

    // Resolve metadata before entering the (synchronous) transaction
    const metadata =
      entry.metadata === undefined ? undefined : await entry.metadata;

    // Put the new entry into the metadata store, atomically fetching the old
    // entry's blob ID (if any) for garbage collection.
    const maybeOldBlobId = this.#storage.transactionSync(() => {
      const previous = this.#sql
        .exec<Pick<Row, "blob_id">>(
          "SELECT blob_id FROM _mf_entries WHERE key = ?1",
          entry.key,
        )
        .toArray()
        .at(0);
      this.#sql.exec(
        "INSERT OR REPLACE INTO _mf_entries (key, blob_id, expiration, metadata) VALUES (?1, ?2, ?3, ?4)",
        entry.key,
        blobId,
        entry.expiration ?? null,
        metadata === undefined ? null : JSON.stringify(metadata),
      );
      return previous?.blob_id;
    });
    if (maybeOldBlobId !== undefined) this.#backgroundDelete(maybeOldBlobId);
  }

  async delete(key: string): Promise<boolean> {
    // Try to delete the key from the metadata store, returning false if not found
    const row = this.#sql
      .exec<Pick<Row, "blob_id" | "expiration">>(
        "DELETE FROM _mf_entries WHERE key = ?1 RETURNING blob_id, expiration",
        key,
      )
      .toArray()
      .at(0);
    if (row === undefined) return false;
    // Garbage collect the deleted entry's blob
    this.#backgroundDelete(row.blob_id);
    // Return true iff this entry hasn't expired
    return !this.#hasExpired(row);
  }

  deleteAll(): number {
    // Get all blob IDs and delete all entries in one statement
    const rows = this.#sql
      .exec<Pick<Row, "blob_id">>("DELETE FROM _mf_entries RETURNING blob_id")
      .toArray();
    // Garbage collect all blobs in the background
    for (const { blob_id } of rows) this.#backgroundDelete(blob_id);
    return rows.length;
  }

  list(opts: KeyEntriesQuery): KeyEntries<Metadata> {
    // Find non-expired entries matching the query after the cursor
    const now = this.#timers.now();
    const prefix = opts.prefix ?? "";
    // Note the "" default here prohibits empty string keys.
    const startAfter =
      opts.cursor === undefined ? "" : base64Decode(opts.cursor);
    // Query one extra row: if it's returned, there are more results and we
    // should return a cursor. Truncated to the requested limit below.
    const rows = this.#sql
      .exec<Omit<Row, "blob_id">>(
        `SELECT key, expiration, metadata FROM _mf_entries
        WHERE substr(key, 1, length(?1)) = ?1
        AND key > ?2
        AND (expiration IS NULL OR expiration >= ?3)
        ORDER BY key LIMIT ?4`,
        prefix,
        startAfter,
        now,
        opts.limit + 1,
      )
      .toArray();

    // Garbage collect expired entries. As with `get()`, assuming a
    // monotonically increasing clock, this doesn't need to be in a transaction.
    // (`expiration` may be `NULL`, but `NULL < ...` is falsy.)
    const expiredRows = this.#sql
      .exec<Pick<Row, "blob_id">>(
        "DELETE FROM _mf_entries WHERE expiration < ?1 RETURNING blob_id",
        now,
      )
      .toArray();
    for (const row of expiredRows) this.#backgroundDelete(row.blob_id);

    const hasMoreRows = rows.length === opts.limit + 1;
    rows.splice(opts.limit, 1);

    const keys = rows.map((row) => rowEntry<Metadata>(row));

    // The cursor encodes a key to start after rather than the key to start at
    // to ensure keys added between `list()` calls are returned.
    const nextCursor = hasMoreRows
      ? base64Encode(rows[opts.limit - 1].key)
      : undefined;

    return { keys, cursor: nextCursor };
  }
}
