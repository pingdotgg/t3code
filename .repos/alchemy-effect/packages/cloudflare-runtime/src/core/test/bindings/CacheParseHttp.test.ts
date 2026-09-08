// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's `parseHttpResponse` tests
 * (`workers-sdk/packages/miniflare/test/fixtures/cache/parse-http.ts`).
 * Upstream runs these inside a worker; `parse-http.shared.ts` only uses
 * web-standard APIs, so they run directly in Node here.
 */
import { describe, expect, it } from "@effect/vitest";
import { parseHttpResponse } from "../../bindings/cache/parse-http.shared.ts";

const ENCODER = new TextEncoder();

function createChunkedStream(chunks: Array<string>) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(ENCODER.encode(chunk));
      }
    },
  });
}

async function reduceResponse(res: Response) {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers),
    body: await res.text(),
  };
}

describe("parseHttpResponse", () => {
  it("parses with Transfer-Encoding: chunked as last header", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Content-Type: text/plain\r",
      "\nTransfer-Encoding: chunked\r\n",
      "\r\nabc",
      "def",
      "ghi",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
      body: "abcdefghi",
    });
  });

  it("parses with Transfer-Encoding: chunked split over multiple chunks", async () => {
    const chunks = [
      "HTTP/1 200 OK\r\n", // ...and check using version without dot
      "Transfer-",
      "Encoding: chun",
      "ked\r",
      "\nContent-Type: text/html\r",
      "\n\r\nabc",
      "def",
      "ghi",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/html", "transfer-encoding": "chunked" },
      body: "abcdefghi",
    });
  });

  it("parses without Transfer-Encoding: chunked", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Content-Type: text/xml\r\n\r\n",
      "abc",
      "def",
      "ghi",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/xml" },
      body: "abcdefghi",
    });
  });

  it("parses with end-of-headers split over multiple chunks", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Content-Type: text/plain\r",
      "\nTransfer-Encoding: chunked\r",
      "\n\r",
      "\nabc",
      "def",
      "ghi",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain", "transfer-encoding": "chunked" },
      body: "abcdefghi",
    });
  });

  it("rejects without end-of-headers (this shouldn't ever happen)", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Content-Type: text/plain\r",
      "\nTransfer-Encoding: chunked\r\n",
    ];
    await expect(
      parseHttpResponse(createChunkedStream(chunks)),
    ).rejects.toThrow("Expected to find blank line in HTTP message");
  });

  // HTTP messages sent by `workerd` (obtained by setting `workerd`'s
  // `cacheApiOutbound` to an external `nc -l` service)
  it("parses workerd message with Content-Length", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Content-Length: 4\r\n",
      "Content-Type: text/plain;charset=UTF-8\r\n",
      "Cache-Control: max-age=3600\r\n",
      "\r\n",
      "body",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: {
        "content-length": "4",
        "content-type": "text/plain;charset=UTF-8",
        "cache-control": "max-age=3600",
      },
      body: "body",
    });
  });

  it("parses workerd message with Transfer-Encoding: chunked", async () => {
    const chunks = [
      "HTTP/1.1 200 OK\r\n",
      "Transfer-Encoding: chunked\r\n",
      "Cache-Control: max-age=3600\r\n",
      "\r\n",
      "hi",
      "cache",
    ];
    const res = await parseHttpResponse(createChunkedStream(chunks));
    expect(await reduceResponse(res)).toEqual({
      status: 200,
      statusText: "OK",
      headers: {
        "transfer-encoding": "chunked",
        "cache-control": "max-age=3600",
      },
      body: "hicache",
    });
  });
});
