import type * as Stream from "effect/Stream";

export const getRawStream = (
  stream: Stream.Stream<any, any, any>,
): ReadableStream | undefined =>
  streamHasRaw(stream) ? stream.raw : undefined;

export const streamHasRaw = (
  stream: Stream.Stream<any, any, any>,
): stream is Stream.Stream<any, any, any> & {
  raw: ReadableStream;
} => "raw" in stream && stream.raw != null;
