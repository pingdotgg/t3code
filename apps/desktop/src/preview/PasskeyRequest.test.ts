import { describe, expect, it } from "vite-plus/test";
import { normalizePasskeyRequest, passkeyRpId } from "./PasskeyRequest.ts";

const registration = {
  challenge: "AQID",
  rp: { name: "Example", id: "example.com" },
  user: { id: "BAUG", name: "alice", displayName: "Alice" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

describe("preview passkey requests", () => {
  it("accepts the current site or its registrable parent, including localhost development", () => {
    expect(passkeyRpId("https://login.example.com:8443", "example.com")).toBe("example.com");
    expect(passkeyRpId("http://localhost:3000")).toBe("localhost");
    expect(passkeyRpId("https://project.github.io")).toBe("project.github.io");
  });
  it("canonicalizes mixed-case and international RP hostnames", () => {
    expect(passkeyRpId("https://login.example.com", "EXAMPLE.COM")).toBe("example.com");
    expect(passkeyRpId("https://login.xn--bcher-kva.example", "BÜCHER.example")).toBe(
      "xn--bcher-kva.example",
    );
  });
  it.each([
    "",
    "example.com/path",
    "example.com:443",
    "example.com?x",
    "user@example.com",
    "%65xample.com",
    " example.com",
  ])("rejects a non-hostname RP ID: %s", (rp) => {
    expect(() => passkeyRpId("https://example.com", rp)).toThrow(
      expect.objectContaining({ name: "SecurityError" }),
    );
  });
  it.each(["A", "AAAAA", "AB", "", "AQ==", "AQ+"])(
    "rejects malformed credential bytes on both operations: %s",
    (id) => {
      expect(() =>
        normalizePasskeyRequest(
          "get",
          { challenge: "AQID", allowCredentials: [{ type: "public-key", id }] },
          "https://example.com",
        ),
      ).toThrow();
      expect(() =>
        normalizePasskeyRequest(
          "create",
          { ...registration, excludeCredentials: [{ type: "public-key", id }] },
          "https://example.com",
        ),
      ).toThrow();
    },
  );
  it.each([
    ["https://example.com", "evil.com"],
    ["https://example.com", "com"],
    ["https://example.co.uk", "co.uk"],
    ["https://project.github.io", "github.io"],
    ["http://example.com", "example.com"],
    ["file:///tmp/page.html", "localhost"],
    ["https://127.0.0.1", "127.0.0.1"],
    ["https://evilexample.com", "example.com"],
  ])("rejects an insecure origin or unrelated/public-suffix RP: %s / %s", (origin, rp) => {
    expect(() => passkeyRpId(origin, rp)).toThrow(
      expect.objectContaining({ name: "SecurityError" }),
    );
  });
  it("preserves the real page origin and explicit credential and verification constraints", () => {
    expect(
      normalizePasskeyRequest(
        "get",
        {
          challenge: "AQID",
          rpId: "example.com",
          userVerification: "required",
          allowCredentials: [{ type: "public-key", id: "BAUG" }],
          origin: "https://evil.com",
        },
        "https://login.example.com:8443",
      ),
    ).toMatchObject({
      operation: "get",
      origin: "https://login.example.com:8443",
      rpId: "example.com",
      challenge: "AQID",
      credentials: ["BAUG"],
      userVerification: "required",
    });
  });
  it("converts registration and preserves duplicate prevention", () => {
    expect(
      normalizePasskeyRequest(
        "create",
        {
          ...registration,
          excludeCredentials: [{ type: "public-key", id: "BwgJ" }],
          extensions: { credProps: true },
        },
        "https://example.com",
      ),
    ).toMatchObject({
      credentials: ["BwgJ"],
      userName: "alice",
      userId: "BAUG",
      displayName: "Alice",
      credProps: true,
    });
  });
  it("rejects malformed binary data and unsupported required algorithms/extensions", () => {
    expect(() =>
      normalizePasskeyRequest("get", { challenge: "not base64" }, "https://example.com"),
    ).toThrow();
    for (const options of [
      { ...registration, pubKeyCredParams: [{ type: "public-key", alg: -257 }] },
      { ...registration, extensions: { largeBlob: { support: "required" } } },
    ])
      expect(() => normalizePasskeyRequest("create", options, "https://example.com")).toThrow(
        expect.objectContaining({ name: "NotSupportedError" }),
      );
  });
});
