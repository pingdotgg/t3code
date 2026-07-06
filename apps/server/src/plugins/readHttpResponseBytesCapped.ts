import { PluginManagementError } from "@t3tools/contracts/plugin";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/unstable/http";

const isPluginManagementError = Schema.is(PluginManagementError);

export const readHttpResponseBytesCapped = (input: {
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly maxBytes: number;
  readonly tooLarge: (observedBytes: number) => PluginManagementError;
  readonly readFailed: (cause: unknown) => PluginManagementError;
}) =>
  input.response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Array<Uint8Array>, total: 0 }),
      (acc, chunk) => {
        const total = acc.total + chunk.byteLength;
        if (total > input.maxBytes) {
          return Effect.fail(input.tooLarge(total));
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
    Effect.mapError((cause) => (isPluginManagementError(cause) ? cause : input.readFailed(cause))),
  );
