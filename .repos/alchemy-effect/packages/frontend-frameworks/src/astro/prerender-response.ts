// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.4.2 (`src/utils/prerender-response.ts`).
/**
 * Node-side reader for the framed prerender responses the prerender worker
 * writes with `createFramedPrerenderResponse`. Kept out of the worker runtime
 * so the metadata Schema never ships in the worker bundle.
 */
import type { PrerenderRenderMetadata } from "astro";
import * as Schema from "effect/Schema";
import {
  MAX_METADATA_LENGTH,
  METADATA_LENGTH_BYTES,
  PRERENDER_RESPONSE_CONTENT_TYPE,
} from "./runtime/utils/prerender-response.ts";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const ResponseMetadata = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  statusText: Schema.String,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  hasBody: Schema.Boolean,
  metadata: Schema.optional(
    Schema.Struct({
      contentEntryKeys: Schema.Array(Schema.String),
      staticImages: Schema.Array(Schema.Unknown),
      referencedImages: Schema.String.pipe(Schema.Array, Schema.optional),
    }),
  ),
}).check(
  Schema.makeFilter(({ status, hasBody }) => !(hasBody && NULL_BODY_STATUSES.has(status)), {
    message: "a null-body status cannot carry a body",
  }),
);

// oxlint-disable-next-line effecttsgo/schema-sync -- decoded inside an async, non-Effect reader
const decodeResponseMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(ResponseMetadata));

export async function readFramedPrerenderResponse(
  transportResponse: Response,
): Promise<{ response: Response; metadata: PrerenderRenderMetadata | undefined }> {
  if (!transportResponse.ok) {
    throw new Error(
      `The framed prerender request failed (${transportResponse.status}: ${transportResponse.statusText}).`,
    );
  }
  if (transportResponse.headers.get("Content-Type") !== PRERENDER_RESPONSE_CONTENT_TYPE) {
    throw new Error("The prerender response is not framed.");
  }
  if (!transportResponse.body) {
    throw new Error("The framed prerender response has no body.");
  }

  const reader = transportResponse.body.getReader();
  let chunk: Uint8Array | undefined;
  let chunkOffset = 0;
  const nextChunk = async (): Promise<Uint8Array> => {
    const next = await reader.read();
    if (next.done) throw new Error("The framed prerender response ended unexpectedly.");
    chunk = next.value;
    chunkOffset = 0;
    return next.value;
  };
  const readExactly = async (length: number): Promise<Uint8Array> => {
    const bytes = new Uint8Array(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const current = chunk && chunkOffset < chunk.byteLength ? chunk : await nextChunk();
      const available = current.byteLength - chunkOffset;
      const count = Math.min(length - bytesRead, available);
      bytes.set(current.subarray(chunkOffset, chunkOffset + count), bytesRead);
      chunkOffset += count;
      bytesRead += count;
    }
    return bytes;
  };

  try {
    const lengthBytes = await readExactly(METADATA_LENGTH_BYTES);
    const metadataLength = new DataView(
      lengthBytes.buffer,
      lengthBytes.byteOffset,
      lengthBytes.byteLength,
    ).getUint32(0);
    if (metadataLength === 0 || metadataLength > MAX_METADATA_LENGTH) {
      throw new Error("The framed prerender response metadata length is invalid.");
    }
    const metadataBytes = await readExactly(metadataLength);
    const responseMetadata = decodeResponseMetadata(new TextDecoder().decode(metadataBytes));

    let remainder =
      chunk && chunkOffset < chunk.byteLength ? chunk.subarray(chunkOffset) : undefined;
    let body: ReadableStream<Uint8Array> | null = null;
    if (responseMetadata.hasBody) {
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (remainder) {
            controller.enqueue(remainder);
            remainder = undefined;
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    } else {
      await reader.cancel();
    }

    return {
      response: new Response(body, {
        status: responseMetadata.status,
        statusText: responseMetadata.statusText,
        headers: responseMetadata.headers.map(([name, value]): [string, string] => [name, value]),
      }),
      metadata: responseMetadata.metadata as PrerenderRenderMetadata | undefined,
    };
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the framing error when cancellation also fails.
    }
    throw error;
  }
}
