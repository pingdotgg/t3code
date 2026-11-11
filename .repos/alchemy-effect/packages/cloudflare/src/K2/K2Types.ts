import type * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Data from "effect/Data";
import type * as Schema from "effect/Schema";

/**
 * A record to append to a K2 stream.
 *
 * `content` is the payload: raw bytes, or a string encoded as UTF-8.
 * `headers` are up to 32 string headers describing the content. A record
 * (content and headers combined) can be at most 1 MB.
 */
export interface Record {
  content: Uint8Array | ArrayBuffer | string;
  headers?: { [key: string]: string };
}

/**
 * A record in the shape every K2 producer path sends: bytes plus headers.
 * Built by a client's `encode` and accepted by its `sendEncoded`.
 */
export interface EncodedRecord {
  content: Uint8Array;
  headers?: { [key: string]: string };
}

/**
 * A record read from a K2 subscription. `content` is the decoded payload,
 * `timestamp` is when K2 received the record.
 */
export interface ConsumedRecord {
  content: Uint8Array;
  headers: { [key: string]: string };
  timestamp: Date;
}

/**
 * A consumed record whose JSON content was decoded with a schema
 * (`consumeStreamRecords(stream, { schema }, handler)`).
 */
export interface DecodedRecord<A> extends ConsumedRecord {
  value: A;
}

/**
 * A batch of records leased to one worker id for five minutes. Ack it once
 * the records are processed, nack it to have them redelivered, or extend it
 * while processing takes longer than the lease.
 */
export interface Batch {
  batchId: string;
  workerId: string;
  /** When the lease expires. */
  leasedUntil: Date;
  records: ReadonlyArray<ConsumedRecord>;
}

/** Where a new subscription starts reading. */
export type StartAt = "earliest" | "latest";

/**
 * A JSON codec for record payloads. `send` encodes values to JSON with it;
 * `consumeStreamRecords` decodes record content with it.
 */
export type RecordSchema<A> = Schema.Codec<A, any, never, never>;

/**
 * Raised when a value cannot be encoded with (or a record decoded with) the
 * binding's schema.
 */
export class K2SchemaError extends Data.TaggedError("K2SchemaError")<{
  message: string;
  cause?: unknown;
}> {}

/** Errors a K2 producer (`WriteStream`, `StreamSink`) can fail with. */
export type ProduceError = k2.ProduceError | K2SchemaError;

/** Errors {@link ReadSubscriptionClient.consume} can fail with. */
export type ConsumeError = k2.ConsumeError;

/** Errors {@link ReadSubscriptionClient.ack} can fail with. */
export type AckError = k2.AckBatchError;

/** Errors {@link ReadSubscriptionClient.nack} can fail with. */
export type NackError = k2.NackBatchError;

/** Errors {@link ReadSubscriptionClient.extend} can fail with. */
export type ExtendError = k2.ExtendLeaseError;
