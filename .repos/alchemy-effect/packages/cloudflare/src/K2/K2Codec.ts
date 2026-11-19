import type * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type ConsumedRecord,
  type DecodedRecord,
  type EncodedRecord,
  K2SchemaError,
  type Record as K2Record,
  type RecordSchema,
} from "./K2Types.ts";

/**
 * Record encoding shared by the K2 producer and consumer clients. Internal —
 * not exported from the K2 barrel.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Header K2 producers set on schema-encoded (JSON) records. */
export const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Normalize record content to bytes; strings are UTF-8 encoded. */
export const toBytes = (content: Uint8Array | ArrayBuffer | string): Uint8Array =>
  typeof content === "string"
    ? encoder.encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

/** Standard (padded) base64, chunked so large payloads don't overflow `apply`. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const fromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** Encode untyped records: content to bytes, headers passed through. */
export const encodeRecords = (records: ReadonlyArray<K2Record>): ReadonlyArray<EncodedRecord> =>
  records.map((record) => ({
    content: toBytes(record.content),
    ...(record.headers && Object.keys(record.headers).length > 0
      ? { headers: record.headers }
      : {}),
  }));

/** Encode typed values to JSON records with the binding's schema. */
export const encodeWithSchema =
  <A>(schema: RecordSchema<A>) =>
  (values: ReadonlyArray<A>): Effect.Effect<ReadonlyArray<EncodedRecord>, K2SchemaError> =>
    Effect.forEach(values, (value) =>
      Schema.encodeEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new K2SchemaError({
              message: `Could not encode K2 record: ${cause.message}`,
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          Effect.try({
            try: (): EncodedRecord => ({
              content: encoder.encode(JSON.stringify(encoded)),
              headers: { ...JSON_HEADERS },
            }),
            catch: (cause) =>
              new K2SchemaError({ message: "Could not serialize K2 record as JSON", cause }),
          }),
        ),
      ),
    );

/** The `produce` request body shape for encoded records. */
export const toProduceRecords = (records: ReadonlyArray<EncodedRecord>): Array<k2.ProduceRecord> =>
  records.map((record) => ({
    content: toBase64(record.content),
    ...(record.headers ? { headers: record.headers } : {}),
  }));

/** Decode the `consume` response records into bytes + headers + timestamp. */
export const fromConsumedRecords = (
  records: ReadonlyArray<k2.ConsumedRecord>,
): ReadonlyArray<ConsumedRecord> =>
  records.map((record) => ({
    content: fromBase64(record.content),
    headers: Object.fromEntries(
      Object.entries(record.headers ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timestamp: new Date(record.timestampMs),
  }));

/** Decode JSON record content with a schema into `record.value`. */
export const decodeWithSchema =
  <A>(schema: RecordSchema<A>) =>
  (
    records: ReadonlyArray<ConsumedRecord>,
  ): Effect.Effect<ReadonlyArray<DecodedRecord<A>>, K2SchemaError> =>
    Effect.forEach(records, (record) =>
      Effect.try({
        try: () => JSON.parse(decoder.decode(record.content)) as unknown,
        catch: (cause) =>
          new K2SchemaError({ message: "K2 record content is not valid JSON", cause }),
      }).pipe(
        Effect.flatMap((json) =>
          Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError(
              (cause) =>
                new K2SchemaError({
                  message: `Could not decode K2 record: ${cause.message}`,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((value): DecodedRecord<A> => ({ ...record, value })),
      ),
    );

/**
 * Approximate size K2 counts against the 1 MB record limit: content plus
 * header names and values.
 */
export const recordSize = (record: EncodedRecord): number => {
  let size = record.content.byteLength;
  for (const [key, value] of Object.entries(record.headers ?? {})) {
    size += encoder.encode(key).byteLength + encoder.encode(value).byteLength;
  }
  return size;
};

/**
 * Approximate wire size of a record inside a `produce` request: base64
 * content (4/3 of the bytes) plus headers and JSON framing.
 */
export const wireSize = (record: EncodedRecord): number =>
  Math.ceil(record.content.byteLength / 3) * 4 +
  (recordSize(record) - record.content.byteLength) +
  64;
