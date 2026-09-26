import type { IncomingMessage } from "node:http";
import {
  proxyRequestHeaders,
  resolveForwardedHost,
} from "../forwarded-host.ts";
import { describe, expect, test } from "vitest";

describe("resolveForwardedHost", () => {
  test("prefers the forwarded host over the immediate proxy host", () => {
    expect(
      resolveForwardedHost(
        { host: "localhost:5173", "x-forwarded-host": "example.ngrok.app" },
        "127.0.0.1:9999",
      ),
    ).toBe("example.ngrok.app");
  });

  test("uses the first forwarded host when a proxy chain appends to the header", () => {
    expect(
      resolveForwardedHost(
        {
          host: "localhost:5173",
          "x-forwarded-host": "example.ngrok.app, localhost:5173",
        },
        "127.0.0.1:9999",
      ),
    ).toBe("example.ngrok.app");
  });

  test("uses the first forwarded host when Node exposes repeated headers as an array", () => {
    expect(
      resolveForwardedHost(
        {
          host: "localhost:5173",
          "x-forwarded-host": ["example.ngrok.app", "localhost:5173"],
        },
        "127.0.0.1:9999",
      ),
    ).toBe("example.ngrok.app");
  });

  test("falls back to the request host or the provided fallback", () => {
    expect(
      resolveForwardedHost({ host: "localhost:5173" }, "127.0.0.1:9999"),
    ).toBe("localhost:5173");
    expect(resolveForwardedHost({}, "127.0.0.1:9999")).toBe("127.0.0.1:9999");
  });
});

describe("proxyRequestHeaders", () => {
  const proxySharedSecret = "server-instance-secret";
  test.each([
    [{ host: "localhost:5173" }, false, "http://localhost:5173"],
    [{ host: "localhost:5173" }, true, "https://localhost:5173"],
    [{ host: "localhost:80" }, true, "https://localhost:80"],
    [
      {
        host: "localhost:5173",
        "x-forwarded-host": "public.example, proxy.internal",
        "x-forwarded-proto": "https, http",
      },
      false,
      "https://public.example",
    ],
  ])(
    "signs the original URL including protocol and port",
    (headers, encrypted, origin) => {
      const result = proxyRequestHeaders(
        {
          headers: {
            ...headers,
            "alchemy-runtime-original-url": "https://forged.example/",
            "alchemy-runtime-proxy-shared-secret": "forged",
          },
          socket: { encrypted },
        } as unknown as IncomingMessage,
        new URL("http://127.0.0.1:9999//callback/%2F?x=1&x=2"),
        proxySharedSecret,
      );
      expect(result["alchemy-runtime-original-url"]).toBe(
        `${origin}//callback/%2F?x=1&x=2`,
      );
      expect(result.host).toBe(new URL(origin).host);
      expect(result["alchemy-runtime-proxy-shared-secret"]).toBe(
        proxySharedSecret,
      );
    },
  );
});
