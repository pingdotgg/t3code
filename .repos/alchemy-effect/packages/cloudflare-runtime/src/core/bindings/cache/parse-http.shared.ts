// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Parser for serialised HTTP responses, adapted from Miniflare's
 * `workers-sdk/packages/miniflare/src/workers/cache/cache.worker.ts`
 * (`parseHttpResponse`). workerd's Cache API serialises the response to cache
 * as a full HTTP message and `PUT`s it to the cache service as the request
 * body; this parses that message back into a `Response`.
 *
 * Uses only web-standard APIs so it can be unit-tested from Node.
 */

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
const STATUS_REGEXP =
  /^HTTP\/\d(?:\.\d)? (?<rawStatusCode>\d+) (?<statusText>.*)$/;

/** Returns the index of the first `\r\n\r\n` in `buffer`, or -1. */
function findBlankLineIndex(buffer: Uint8Array): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (
      buffer[i] === CR &&
      buffer[i + 1] === LF &&
      buffer[i + 2] === CR &&
      buffer[i + 3] === LF
    ) {
      return i;
    }
  }
  return -1;
}

export async function parseHttpResponse(
  stream: ReadableStream<Uint8Array>,
): Promise<Response> {
  // Buffer until first "\r\n\r\n"
  let buffer = new Uint8Array(0);
  let blankLineIndex = -1;
  for await (const chunk of stream.values({ preventCancel: true })) {
    const concatenated = new Uint8Array(buffer.length + chunk.length);
    concatenated.set(buffer);
    concatenated.set(chunk, buffer.length);
    buffer = concatenated;
    blankLineIndex = findBlankLineIndex(buffer);
    if (blankLineIndex !== -1) break;
  }
  assert(blankLineIndex !== -1, "Expected to find blank line in HTTP message");

  // Parse status and headers
  const rawStatusHeaders = new TextDecoder().decode(
    buffer.subarray(0, blankLineIndex),
  );
  const [rawStatus, ...rawHeaders] = rawStatusHeaders.split("\r\n");
  // https://www.rfc-editor.org/rfc/rfc7230#section-3.1.2
  const statusMatch = rawStatus.match(STATUS_REGEXP);
  assert(
    statusMatch?.groups != null,
    `Expected first line ${JSON.stringify(rawStatus)} to be HTTP status line`,
  );
  const { rawStatusCode, statusText } = statusMatch.groups;
  const statusCode = parseInt(rawStatusCode);
  // https://www.rfc-editor.org/rfc/rfc7230#section-3.2
  const headers = rawHeaders.map((rawHeader): [string, string] => {
    const index = rawHeader.indexOf(":");
    return [
      rawHeader.substring(0, index),
      rawHeader.substring(index + 1).trim(),
    ];
  });

  // Construct body, by concatenating the prefix (what we read over from
  // headers) with the rest of the stream
  const prefix = buffer.subarray(blankLineIndex + 4 /* "\r\n\r\n" */);
  // Even if `prefix.length === 0` here, we need to construct a new stream.
  // Otherwise, we'll get a `TypeError: This ReadableStream is disturbed...`
  // when constructing the `Response` below.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void writer
    .write(prefix)
    .then(() => {
      writer.releaseLock();
      return stream.pipeTo(writable);
    })
    .catch((e) => console.error("Error writing HTTP body:", e));

  return new Response(readable, { status: statusCode, statusText, headers });
}
