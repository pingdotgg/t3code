import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  isPreviewableUrl,
  newPreviewTabId,
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
} from "./preview.ts";

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

describe("isPreviewableUrl", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000/path",
    "http://0.0.0.0:8080",
    "http://[::1]:5173",
  ])("%s is previewable", (url) => {
    expect(isPreviewableUrl(url)).toBe(true);
  });

  it.each(["https://example.com", "ws://localhost:5173", "file:///etc/passwd", "not-a-url", ""])(
    "%s is not previewable",
    (url) => {
      expect(isPreviewableUrl(url)).toBe(false);
    },
  );
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
    expect(() => normalizePreviewUrl("   ")).toThrow(PreviewUrlNormalizationError);
  });

  it("rejects unsupported protocols", () => {
    expect(() => normalizePreviewUrl("ftp://example.com")).toThrow(PreviewUrlNormalizationError);
    expect(() => normalizePreviewUrl("file:///etc/passwd")).toThrow(PreviewUrlNormalizationError);
  });

  it("rejects unparseable junk", () => {
    expect(() => normalizePreviewUrl("http://")).toThrow(PreviewUrlNormalizationError);
  });
});
