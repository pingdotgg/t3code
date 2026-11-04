// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.4.2 (`src/utils/prerender-response.ts`).
/**
 * Frames prerender response metadata as length-prefixed JSON followed by the
 * raw body bytes. This private protocol transports arbitrary output without
 * base64 encoding or state shared between requests.
 */
import type { PrerenderRenderMetadata } from "astro";
import type { PrerenderResponseMetadata } from "../prerender-types.ts";

export const METADATA_LENGTH_BYTES = 4;
export const MAX_METADATA_LENGTH = 16 * 1024 * 1024;
export const PRERENDER_RESPONSE_CONTENT_TYPE = "application/vnd.astro.prerender";

export function createFramedPrerenderResponse(
  response: Response,
  metadata: PrerenderRenderMetadata | undefined,
): Response {
  const responseMetadata: PrerenderResponseMetadata = {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    hasBody: response.body !== null,
    metadata,
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(responseMetadata));
  if (metadataBytes.byteLength > MAX_METADATA_LENGTH) {
    throw new RangeError("Prerender response metadata is too large to encode.");
  }

  const lengthBytes = new Uint8Array(METADATA_LENGTH_BYTES);
  new DataView(lengthBytes.buffer).setUint32(0, metadataBytes.byteLength);
  const bodyReader = response.body?.getReader();
  let phase = 0;
  const framedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 0) {
        phase = 1;
        controller.enqueue(lengthBytes);
        return;
      }
      if (phase === 1) {
        phase = 2;
        controller.enqueue(metadataBytes);
        if (!bodyReader) controller.close();
        return;
      }
      if (!bodyReader) {
        controller.close();
        return;
      }
      const { done, value } = await bodyReader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return bodyReader?.cancel(reason);
    },
  });

  return new Response(framedBody, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": PRERENDER_RESPONSE_CONTENT_TYPE,
    },
  });
}
