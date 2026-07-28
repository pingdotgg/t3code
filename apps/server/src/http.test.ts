import { expect, it } from "@effect/vitest";
import * as NodeZlib from "node:zlib";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { compressHttpResponse, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

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
      const response = compressHttpResponse(
        HttpServerResponse.text(body, { contentType: "application/json" }),
        "br, gzip, deflate",
      );

      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.headers.vary).toBe("Accept-Encoding");
      expect(response.body._tag).toBe("Stream");
      if (response.body._tag === "Stream") {
        const chunks = yield* Stream.runCollect(Stream.orDie(response.body.stream));
        expect(NodeZlib.gunzipSync(Buffer.concat(Array.from(chunks))).toString()).toBe(body);
      }
    }),
  );

  it("keeps the original body when gzip is declined", () => {
    const response = compressHttpResponse(
      HttpServerResponse.text("x".repeat(2_000), { contentType: "application/json" }),
      "gzip;q=0, *;q=1",
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
      );

    expect(makeResponse("*").headers.vary).toBe("*");
    expect(makeResponse("Origin, accept-encoding").headers.vary).toBe("Origin, accept-encoding");
  });
});
