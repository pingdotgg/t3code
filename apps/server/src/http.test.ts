import { expect, it } from "@effect/vitest";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
import { compressHttpResponse, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

const compressionUnavailable = HttpResponseCompression.HttpResponseCompression.of({
  gzip: () => {
    throw new Error("Unexpected HTTP response compression.");
  },
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("http compression", () => {
  it.effect("gzips large JSON responses when the client accepts it", () =>
    Effect.gen(function* () {
      const body = `{"value":"${"compressible".repeat(1_000)}"}`;
      const compression = yield* HttpResponseCompression.HttpResponseCompression;
      const response = compressHttpResponse(
        HttpServerResponse.text(body, { contentType: "application/json" }),
        "br, gzip, deflate",
        compression,
      );

      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.headers.vary).toBe("Accept-Encoding");
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
      expect(NodeZlib.gunzipSync(Buffer.concat(chunks)).toString()).toBe(body);
    }).pipe(Effect.provide(HttpResponseCompression.layerNode)),
  );

  it("keeps the original body when gzip is declined", () => {
    const response = compressHttpResponse(
      HttpServerResponse.text("x".repeat(2_000), { contentType: "application/json" }),
      "gzip;q=0, *;q=1",
      compressionUnavailable,
    );

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBe("2000");
    expect(response.headers.vary).toBe("Accept-Encoding");
  });

  it("preserves existing Vary semantics", () => {
    const makeResponse = (vary: string) =>
      compressHttpResponse(
        HttpServerResponse.text("x".repeat(2_000), {
          contentType: "application/json",
          headers: { vary },
        }),
        undefined,
        compressionUnavailable,
      );

    expect(makeResponse("*").headers.vary).toBe("*");
    expect(makeResponse("Origin, accept-encoding").headers.vary).toBe("Origin, accept-encoding");
  });
});
