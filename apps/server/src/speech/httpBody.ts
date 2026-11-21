import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/http";

export class SpeechBodyTooLarge extends Schema.TaggedError<SpeechBodyTooLarge>()(
  "SpeechBodyTooLarge",
  {
    maxBytes: Schema.Number,
  },
) {
  override get message() {
    return "The speech response exceeds the byte limit.";
  }
}

export const readBoundedSpeechBody = Effect.fn("SpeechHttpBody.read")(function* (
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
) {
  let received = 0;
  const chunks = yield* response.stream.pipe(
    Stream.tap((chunk) => {
      received += chunk.byteLength;
      return received > maxBytes ? Effect.fail(new SpeechBodyTooLarge({ maxBytes })) : Effect.void;
    }),
    Stream.runCollect,
  );
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});
