import { describe, expect, it } from "vitest";

import { findPairingUrl, parsePairingUrlLine } from "./pairingUrl.ts";

describe("parsePairingUrlLine", () => {
  it("extracts the URL from the server's startup line", () => {
    expect(parsePairingUrlLine("Pairing URL: http://localhost:5733/pair?token=abc")).toBe(
      "http://localhost:5733/pair?token=abc",
    );
  });

  it("accepts the web-mode log annotation form", () => {
    expect(parsePairingUrlLine("  pairingUrl: http://localhost:5734/pair#token=VV5HFLLC3V38")).toBe(
      "http://localhost:5734/pair#token=VV5HFLLC3V38",
    );
  });

  it("tolerates leading whitespace and trailing newlines", () => {
    expect(parsePairingUrlLine("  Pairing URL: http://127.0.0.1:3773/#t=1\r")).toBe(
      "http://127.0.0.1:3773/#t=1",
    );
  });

  it("ignores unrelated and malformed lines", () => {
    expect(parsePairingUrlLine("Token: abc")).toBeUndefined();
    expect(parsePairingUrlLine("Pairing URL: not a url")).toBeUndefined();
    expect(parsePairingUrlLine("Pairing URL:")).toBeUndefined();
  });
});

describe("findPairingUrl", () => {
  it("returns the first pairing URL in multi-line output", () => {
    const output = [
      "T3 Code server is ready.",
      "Connection string: localhost:3773",
      "Pairing URL: http://localhost:3773/pair?token=first",
      "Pairing URL: http://localhost:3773/pair?token=second",
    ].join("\n");
    expect(findPairingUrl(output)).toBe("http://localhost:3773/pair?token=first");
  });

  it("returns undefined when no line matches", () => {
    expect(findPairingUrl("nothing here")).toBeUndefined();
  });
});
