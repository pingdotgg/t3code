import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { encodeRecords, encodeWithSchema } from "./K2Codec.ts";
import type { EncodedRecord, ProduceError, Record as K2Record, RecordSchema } from "./K2Types.ts";
import type { WriteStreamClient } from "./WriteStream.ts";

/**
 * Build a {@link WriteStreamClient} over a transport that appends encoded
 * records. Shared by the binding, HTTP, and local implementations — they
 * differ only in `sendEncoded`. Internal — not exported from the K2 barrel.
 */
export const makeWriteStreamClient = (
  schema: RecordSchema<any> | undefined,
  sendEncoded: (
    records: ReadonlyArray<EncodedRecord>,
  ) => Effect.Effect<void, ProduceError, RuntimeContext>,
): WriteStreamClient<any> => {
  const encode = schema
    ? encodeWithSchema(schema)
    : (records: ReadonlyArray<K2Record>) => Effect.sync(() => encodeRecords(records));
  return {
    encode,
    sendEncoded,
    send: (records) => encode(records).pipe(Effect.flatMap(sendEncoded)),
  };
};
