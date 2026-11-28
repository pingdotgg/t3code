import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { Pipeline, PipelineRecord } from "cloudflare:pipelines";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isLegacyPipeline, type LegacyPipeline } from "./LegacyPipeline.ts";
import type { Stream } from "./Stream.ts";
import { StreamSendError, type WriteStreamClient } from "./WriteStream.ts";

/**
 * Shared record encoding + client assembly for the WriteStream / StreamSink
 * implementations. Internal — not exported from the Pipelines barrel.
 */

/**
 * The Effect Schema a stream was declared with, if any. Legacy pipelines
 * have none.
 */
export const recordSchemaOf = (stream: Stream<any> | LegacyPipeline): Schema.Top | undefined => {
  if (isLegacyPipeline(stream)) return undefined;
  // References (`Stream.ref`) proxy unknown properties to Outputs — only a
  // real Effect Schema counts.
  const schema: unknown = stream.RecordSchema;
  return Schema.isSchema(schema) ? schema : undefined;
};

/**
 * Build the batch encoder: `Schema.toCodecJson(schema)` per record when
 * the stream has an Effect Schema, identity otherwise.
 */
export const makeRecordEncoder = (
  schema: Schema.Top | undefined,
): ((
  records: ReadonlyArray<unknown>,
) => Effect.Effect<ReadonlyArray<PipelineRecord>, StreamSendError>) => {
  if (schema === undefined) {
    return (records) => Effect.succeed(records as ReadonlyArray<PipelineRecord>);
  }
  const encode = Schema.encodeUnknownEffect(
    Schema.toCodecJson(schema as unknown as Schema.Codec<unknown, unknown, never, never>),
  );
  return (records) =>
    Effect.forEach(records, (record, index) =>
      encode(record).pipe(
        Effect.map((json) => json as PipelineRecord),
        Effect.mapError(
          (issue) =>
            new StreamSendError({
              message: `record ${index} does not match the stream schema: ${issue.message}`,
              cause: issue,
              reason: "InvalidRecord",
              index,
            }),
        ),
      ),
    );
};

/** Wrap any transport failure as a `SendFailed` {@link StreamSendError}. */
export const toStreamSendError = (error: unknown): StreamSendError =>
  new StreamSendError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown pipeline error",
    cause: error,
    reason: "SendFailed",
  });

/** Assemble a {@link WriteStreamClient} from an encoder and a transport. */
export const makeStreamClient = (options: {
  schema: Schema.Top | undefined;
  raw: Effect.Effect<Pipeline, never, RuntimeContext>;
  sendEncoded: (
    records: ReadonlyArray<PipelineRecord>,
  ) => Effect.Effect<void, StreamSendError, RuntimeContext>;
}): WriteStreamClient<any> => {
  const encode = makeRecordEncoder(options.schema);
  return {
    raw: options.raw,
    encode,
    sendEncoded: options.sendEncoded,
    send: (records) => encode(records).pipe(Effect.flatMap(options.sendEncoded)),
  };
};

const encoder = new TextEncoder();

/**
 * Approximate wire size of one encoded record in the JSON array body:
 * its UTF-8 JSON plus the separating comma. Values JSON cannot encode
 * count as 1 byte; the send rejects them and the error surfaces.
 */
export const recordSize = (record: PipelineRecord): number => {
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch {
    json = undefined;
  }
  return (json === undefined ? 0 : encoder.encode(json).length) + 1;
};
