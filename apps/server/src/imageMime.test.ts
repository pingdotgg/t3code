import { describe, expect, it } from "vite-plus/test";

import { inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime type", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects non-base64 data URL", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8,hello")).toBeNull();
  });

  it("rejects missing mime type", () => {
    expect(parseBase64DataUrl("data:;base64,SGVsbG8=")).toBeNull();
  });

  it("parses base64 data URL with spaces in payload", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs bG8=\n")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects payload with characters outside the base64 alphabet", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs!bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVs,bG8=")).toBeNull();
  });

  it("rejects structurally malformed base64", () => {
    // '=' before the trailing padding position
    expect(parseBase64DataUrl("data:image/png;base64,AB=CD===")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGV=bG8=")).toBeNull();
    // more than two padding characters
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=====AAA")).toBeNull();
    // length not a multiple of 4
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8")).toBeNull();
  });

  it("accepts base64 with one or two trailing padding characters", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbA==")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbA==",
    });
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8h")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8h",
    });
  });

  it("rejects empty and whitespace-only payloads", () => {
    expect(parseBase64DataUrl("data:image/png;base64,")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64, \r\n")).toBeNull();
  });

  it("parses a case-insensitive scheme and mime type", () => {
    expect(parseBase64DataUrl("DATA:IMAGE/PNG;BASE64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses a multi-megabyte payload from a deep call stack", () => {
    // Regression: matching the payload with a regex borrowed the JS call
    // stack, so a ~10 MB image parsed inside fiber execution threw
    // "RangeError: Maximum call stack size exceeded".
    const dataUrl = `data:image/png;base64,${"A".repeat(14_000_000)}`;
    const atDepth = (depth: number): ReturnType<typeof parseBase64DataUrl> =>
      depth === 0 ? parseBase64DataUrl(dataUrl) : atDepth(depth - 1);
    const findMaxDepth = (depth: number): number => {
      try {
        return findMaxDepth(depth + 1);
      } catch {
        return depth;
      }
    };
    const result = atDepth(Math.floor(findMaxDepth(0) * 0.85));
    expect(result?.mimeType).toBe("image/png");
    expect(result?.base64.length).toBe(14_000_000);
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});
