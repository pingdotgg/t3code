import { expect, it } from "vite-plus/test";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import * as BunHttpResponseCompression from "./BunHttpResponseCompression.ts";
import * as NodeHttpResponseCompression from "./NodeHttpResponseCompression.ts";

const body = new TextEncoder().encode(`{"value":"${"compressible".repeat(1_000)}"}`);

it("creates a raw Node gzip stream", async () => {
  const response = NodeHttpResponseCompression.make.gzip(body, {
    contentType: "application/json",
  });

  expect(response.body._tag).toBe("Raw");
  if (response.body._tag !== "Raw") throw new Error("Expected a raw response body.");
  expect(response.body.body).toBeInstanceOf(NodeStream.Readable);
  if (!(response.body.body instanceof NodeStream.Readable)) {
    throw new Error("Expected a Node readable.");
  }

  const chunks: Array<Buffer> = [];
  for await (const chunk of response.body.body) {
    chunks.push(Buffer.from(chunk));
  }
  expect(NodeZlib.gunzipSync(Buffer.concat(chunks))).toEqual(Buffer.from(body));
});

it("creates a raw Bun gzip stream", async () => {
  const response = BunHttpResponseCompression.make.gzip(body, {
    contentType: "application/json",
  });

  expect(response.body._tag).toBe("Raw");
  if (response.body._tag !== "Raw") throw new Error("Expected a raw response body.");
  expect(response.body.body).toBeInstanceOf(ReadableStream);
  if (!(response.body.body instanceof ReadableStream)) {
    throw new Error("Expected a Web readable stream.");
  }

  const compressed = await new Response(response.body.body).arrayBuffer();
  expect(NodeZlib.gunzipSync(compressed)).toEqual(Buffer.from(body));
});
