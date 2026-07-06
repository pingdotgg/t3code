import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/unstable/http";

interface CappedReadExpectedFailure<E> {
  readonly _tag: "CappedReadExpectedFailure";
  readonly error: E;
}

const expectedFailure = <E>(error: E): CappedReadExpectedFailure<E> => ({
  _tag: "CappedReadExpectedFailure",
  error,
});

const isExpectedFailure = <E>(cause: unknown): cause is CappedReadExpectedFailure<E> =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause as { readonly _tag?: unknown })._tag === "CappedReadExpectedFailure";

export const readHttpResponseBytesCapped = <E>(input: {
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly maxBytes: number;
  readonly tooLarge: (observedBytes: number) => E;
  readonly readFailed: (cause: unknown) => E;
}) =>
  input.response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, total: 0 }),
      (acc, chunk) => {
        const total = acc.total + chunk.byteLength;
        if (total > input.maxBytes) {
          return Effect.fail(expectedFailure(input.tooLarge(total)));
        }
        acc.chunks.push(chunk);
        return Effect.succeed({ chunks: acc.chunks, total });
      },
    ),
    Effect.map(({ chunks, total }) => {
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
    Effect.mapError((cause) =>
      isExpectedFailure<E>(cause) ? cause.error : input.readFailed(cause),
    ),
  );
