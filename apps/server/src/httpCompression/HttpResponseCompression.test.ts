import { expect, it } from "@effect/vitest";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";

import * as HttpResponseCompression from "./HttpResponseCompression.ts";

const body = new TextEncoder().encode(`{"value":"${"compressible".repeat(1_000)}"}`);

it.layer(HttpResponseCompression.layerNode)("Node HTTP response compression", (it) => {
  it.effect("creates a raw gzip stream", () =>
    Effect.gen(function* () {
      const compression = yield* HttpResponseCompression.HttpResponseCompression;
      const response = compression.gzip(body, {
        contentType: "application/json",
      });

      expect(response.body._tag).toBe("Raw");
      if (response.body._tag !== "Raw") throw new Error("Expected a raw response body.");
      expect(response.body.body).toBeInstanceOf(NodeStream.Readable);
      if (!(response.body.body instanceof NodeStream.Readable)) {
        throw new Error("Expected a Node readable.");
      }

      const rawBody = response.body.body;
      const chunks = yield* Effect.promise(async () => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of rawBody) {
          chunks.push(Buffer.from(chunk));
        }
        return chunks;
      });
      expect(NodeZlib.gunzipSync(Buffer.concat(chunks))).toEqual(Buffer.from(body));
    }),
  );
});

it.layer(HttpResponseCompression.layerBun)("Bun HTTP response compression", (it) => {
  it.effect("creates a raw gzip stream", () =>
    Effect.gen(function* () {
      const compression = yield* HttpResponseCompression.HttpResponseCompression;
      const response = compression.gzip(body, {
        contentType: "application/json",
      });

      expect(response.body._tag).toBe("Raw");
      if (response.body._tag !== "Raw") throw new Error("Expected a raw response body.");
      expect(response.body.body).toBeInstanceOf(ReadableStream);
      if (!(response.body.body instanceof ReadableStream)) {
        throw new Error("Expected a Web readable stream.");
      }

      const rawBody = response.body.body;
      const compressed = yield* Effect.promise(() => new Response(rawBody).arrayBuffer());
      expect(NodeZlib.gunzipSync(compressed)).toEqual(Buffer.from(body));
    }),
  );
});
