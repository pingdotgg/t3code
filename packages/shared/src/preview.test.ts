import { describe, expect, it } from "vite-plus/test";

import {
  isLoopbackHost,
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
  resolveAddressBarInput,
} from "./preview.ts";

describe("resolveAddressBarInput", () => {
  it("opens what users type as addresses", () => {
    expect(resolveAddressBarInput("localhost:5173")).toBe("http://localhost:5173/");
    expect(resolveAddressBarInput("127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000/path");
    expect(resolveAddressBarInput("my-box.tailnet.ts.net")).toBe("https://my-box.tailnet.ts.net/");
    expect(resolveAddressBarInput("cnn.com")).toBe("https://cnn.com/");
    expect(resolveAddressBarInput("devbox:8080")).toBe("https://devbox:8080/");
    expect(resolveAddressBarInput(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(resolveAddressBarInput("example.com:8080")).toBe("https://example.com:8080/");
    expect(resolveAddressBarInput("[::1]:3000")).toBe("http://[::1]:3000/");
    expect(resolveAddressBarInput("192.168.1.5:3000")).toBe("https://192.168.1.5:3000/");
  });

  it("searches for text that is not an address", () => {
    expect(resolveAddressBarInput("weather")).toBe("https://duckduckgo.com/?q=weather");
    expect(resolveAddressBarInput("how to center a div")).toBe(
      "https://duckduckgo.com/?q=how%20to%20center%20a%20div",
    );
    expect(resolveAddressBarInput("what is cnn.com")).toBe(
      "https://duckduckgo.com/?q=what%20is%20cnn.com",
    );
    expect(resolveAddressBarInput("what is https://example.com")).toBe(
      "https://duckduckgo.com/?q=what%20is%20https%3A%2F%2Fexample.com",
    );
    expect(resolveAddressBarInput("what is 10:30")).toBe(
      "https://duckduckgo.com/?q=what%20is%2010%3A30",
    );
    expect(resolveAddressBarInput("note: buy milk")).toBe(
      "https://duckduckgo.com/?q=note%3A%20buy%20milk",
    );
  });

  it("still rejects empty input and unsupported schemes", () => {
    expect(() => resolveAddressBarInput("  ")).toThrow(PreviewUrlNormalizationError);
    expect(() => resolveAddressBarInput("ftp://example.com")).toThrow(PreviewUrlNormalizationError);
    expect(() => resolveAddressBarInput("mailto:alice@example.com")).toThrow(
      PreviewUrlNormalizationError,
    );
    expect(() => resolveAddressBarInput("data:text/plain,hello")).toThrow(
      PreviewUrlNormalizationError,
    );
    // A known scheme with a numeric payload is not a host and port.
    for (const input of ["ftp:21", "tel:5551234"]) {
      expect(() => resolveAddressBarInput(input)).toThrow(PreviewUrlNormalizationError);
    }
    expect(resolveAddressBarInput("devbox:8080")).toBe("https://devbox:8080/");
  });
});

describe("newPreviewTabId", () => {
  it("returns a unique tab id every call", () => {
    const a = newPreviewTabId();
    const b = newPreviewTabId();
    expect(a).not.toBe(b);
    expect(a.startsWith("tab_")).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["example.com", "192.168.1.10", "10.0.0.1", ""])("%s is not loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("normalizePreviewUrl", () => {
  it("treats bare loopback hosts as http", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("treats bare public hosts as https", () => {
    expect(normalizePreviewUrl("example.com")).toBe("https://example.com/");
  });

  it("respects explicit schemes", () => {
    expect(normalizePreviewUrl("https://localhost:5173")).toBe("https://localhost:5173/");
    expect(normalizePreviewUrl("http://example.com/path?q=1")).toBe("http://example.com/path?q=1");
  });

  it("rejects empty input", () => {
    try {
      normalizePreviewUrl("   ");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({ inputLength: 3, reason: "empty" });
      expect(error).not.toHaveProperty("rawUrl");
      expect("cause" in (error as object)).toBe(false);
    }
  });

  it("rejects unsupported protocols", () => {
    try {
      normalizePreviewUrl("ftp://example.com");
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: "ftp://example.com".length,
        reason: "unsupported-protocol",
        protocol: "ftp:",
      });
    }
  });

  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});
