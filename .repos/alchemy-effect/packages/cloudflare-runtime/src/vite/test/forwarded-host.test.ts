import { resolveForwardedHost } from "../forwarded-host.ts";
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
