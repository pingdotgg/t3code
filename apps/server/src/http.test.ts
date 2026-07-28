import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as HttpResponseCompression from "./httpCompression/HttpResponseCompression.ts";
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

it.layer(HttpResponseCompression.layerNode)("http compression", (it) => {
  it.effect("keeps the original body when gzip is declined", () =>
    Effect.gen(function* () {
      const response = yield* compressHttpResponse(
        HttpServerResponse.text("x".repeat(2_000), { contentType: "application/json" }),
        "gzip;q=0, *;q=1",
      );

      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["content-length"]).toBe("2000");
      expect(response.headers.vary).toBe("Accept-Encoding");
    }),
  );

  it.effect("preserves existing Vary semantics", () =>
    Effect.gen(function* () {
      const makeResponse = (vary: string) =>
        compressHttpResponse(
          HttpServerResponse.text("x".repeat(2_000), {
            contentType: "application/json",
            headers: { vary },
          }),
          undefined,
        );

      expect((yield* makeResponse("*")).headers.vary).toBe("*");
      expect((yield* makeResponse("Origin, accept-encoding")).headers.vary).toBe(
        "Origin, accept-encoding",
      );
    }),
  );
});
